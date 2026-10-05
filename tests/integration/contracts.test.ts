/**
 * Phase 2 step 1 against the LOCAL Supabase stack, through PostgREST with
 * real magic-link sessions: publish a template, generate a contract from a
 * real approved submission, and check pricing, freezing and access.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEMO_TEMPLATE_SECTIONS, DEMO_TEMPLATE_TITLE } from "@/lib/contracts/demo-template";
import { renderedContentSchema } from "@/lib/contracts/content";
import { parseTemplateText } from "@/lib/contracts/template-text";
import { priceSelection } from "@/lib/pricing";
import {
  adminClient,
  bothSeparate,
  clientView,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  localStatus,
  must,
  openLink,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

let admin: Db;
let staff: Db;
let otherStaff: Db;
let catalog: Catalog;
let otherCatalog: Catalog;

/** A real approval: send, client submits through the session functions, staff approve. */
async function approvedEvent(clientEmail: string) {
  const { eventId, clientId } = await createEvent(admin, catalog, clientEmail);
  const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const input = { package_key: "signature", addons: { uplights_4: 1 }, answers: bothSeparate };
  const view = await clientView(admin, catalog.slug, proposalId, sessionHash);
  const priced = priceSelection(view.offer!, input);
  if (!priced.ok) throw new Error("fixture selection did not price");
  const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input });
  expect(submitted.status).toBe("submitted");
  const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  return { eventId, clientId, proposalId, approvalId: (approval as { approval_id: string }).approval_id, priced: priced.selection };
}

async function publishDemo(db: Db, tenantId: string) {
  const { data: templateId } = await must(db.rpc("create_contract_template", { p_tenant_id: tenantId, p_name: `IT DEMO ${randomUUID().slice(0, 6)}`, p_title: DEMO_TEMPLATE_TITLE, p_sections: DEMO_TEMPLATE_SECTIONS }));
  const { data: version } = await must(db.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  await must(db.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "demo" }));
  return { templateId: templateId!, versionId: version!.id };
}

describe("contract templates and drafts (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-contract-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-contract");
    const other = await signedInUser(admin, `it-contract-other-${randomUUID().slice(0, 8)}@example.test`);
    otherStaff = other.db;
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-contract-b");
  });

  afterAll(async () => {
    for (const c of [catalog, otherCatalog]) if (admin && c) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", c.tenantId);
  });

  it("accepts the DEMO text exactly as the editor produces it", async () => {
    const { versionId } = await publishDemo(staff, catalog.tenantId);
    const { data } = await must(staff.from("contract_template_versions").select("sections, placeholders, published_at").eq("id", versionId).single());
    expect(data!.published_at).not.toBeNull();
    expect(data!.sections).toEqual(DEMO_TEMPLATE_SECTIONS);
    expect(data!.placeholders).toContain("payment.balance_due_date");
  });

  it("rejects unknown placeholders typed in the editor", async () => {
    const parsed = parseTemplateText("## Parties\nDear {{client.nickname}}");
    if (!parsed.ok) throw new Error(parsed.error);
    const { error } = await staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "Bad", p_title: "T", p_sections: parsed.sections });
    expect(error?.message).toContain("unknown placeholder {{client.nickname}}");
  });

  it("generates a contract whose amounts equal the approved selection, and freezes it", async () => {
    const { versionId } = await publishDemo(staff, catalog.tenantId);
    const email = `it-contract-client-${randomUUID().slice(0, 6)}@example.test`;
    const { eventId, clientId, approvalId, priced } = await approvedEvent(email);

    // Missing details are reported, not rendered blank.
    const { data: incomplete } = await must(staff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId }));
    expect((incomplete as { status: string; missing: { key: string }[] }).missing.map((m) => m.key)).toEqual([
      "client.phone", "venue.name", "venue.address", "payment.balance_due_date",
    ]);
    await must(admin.from("clients").update({ phone: "+1 438 555 0101" }).eq("id", clientId));
    await must(admin.from("events").update({ venue_name: "IT Hall", venue_address: "9 Test St" }).eq("id", eventId));

    const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const args = { p_approval_id: approvalId, p_template_version_id: versionId, p_balance_due_date: due };
    const [first, second] = await Promise.all([staff.rpc("generate_contract_draft", args), staff.rpc("generate_contract_draft", args)]);
    const results = [first, second].map((r) => r.data as { status: string; contract_id: string });
    expect(results.map((r) => r.status).sort()).toEqual(["created", "replayed"]);
    expect(results[0].contract_id).toBe(results[1].contract_id);

    const { data: contract } = await must(staff.from("contracts").select("*").eq("id", results[0].contract_id).single());
    const deposit = Number((BigInt(priced.total_cents) * BigInt(5000) + BigInt(5000)) / BigInt(10000));
    expect(contract).toMatchObject({
      status: "draft",
      total_cents: priced.total_cents,
      deposit_cents: deposit,
      balance_cents: priced.total_cents - deposit,
      currency: priced.currency,
      balance_due_date: due,
      signer_email: email,
    });
    expect(contract!.commercial_snapshot).toMatchObject({ subtotal_cents: priced.subtotal_cents, tax_breakdown: priced.tax_breakdown });
    const content = renderedContentSchema.parse(contract!.rendered_content);
    expect(content.title).toBe("DEMO, NOT FOR CLIENT USE: DJ services agreement for IT wedding");
    expect(JSON.stringify(content)).not.toContain("{{");
    const { count: drafts } = await admin.from("contracts").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(drafts).toBe(1);

    // Later catalog, client and event edits leave the stored contract untouched.
    await must(admin.from("gear_items").update({ default_price_cents: 99_900 }).eq("id", catalog.gear.uplights));
    await must(admin.from("packages").update({ base_price_cents: 999_900 }).eq("id", catalog.pkg.signature));
    await must(admin.from("clients").update({ name: "Changed", phone: null }).eq("id", clientId));
    await must(admin.from("events").update({ title: "Changed", venue_address: null }).eq("id", eventId));
    const { data: after } = await must(staff.from("contracts").select("*").eq("id", contract!.id).single());
    expect(after).toEqual(contract);

    const { data: event } = await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single());
    expect(event).toEqual({ lifecycle_status: "awaiting_signature", booking_confirmed_at: null });
    const { count: access } = await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(access).toBe(0);
  });

  it("keeps contracts and templates away from other tenants, clients and anonymous users", async () => {
    const { versionId } = await publishDemo(staff, catalog.tenantId);
    const email = `it-contract-client-${randomUUID().slice(0, 6)}@example.test`;
    const { eventId, clientId, approvalId } = await approvedEvent(email);
    const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId }));
    expect((generated as { status: string }).status).toBe("incomplete");

    // Another DJ: no rows, and no generation from this approval.
    expect((await must(otherStaff.from("contract_templates").select("id").eq("tenant_id", catalog.tenantId))).data).toEqual([]);
    expect((await must(otherStaff.from("contract_template_versions").select("id").eq("id", versionId))).data).toEqual([]);
    const otherVersion = await publishDemo(otherStaff, otherCatalog.tenantId);
    expect((await otherStaff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: otherVersion.versionId })).error?.code).toBe("P0002");
    expect((await staff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: otherVersion.versionId })).error?.message).toContain("template version not found");

    // The event's own verified client, signed in: still nothing.
    const client = await signedInUser(admin, email);
    await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, user_id: client.id }));
    expect((await must(client.db.from("contracts").select("id"))).data).toEqual([]);
    expect((await must(client.db.from("contract_template_versions").select("id"))).data).toEqual([]);
    expect((await client.db.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId })).error?.code).toBe("P0002");

    // Anonymous REST calls are refused outright.
    const env = localStatus();
    const anon = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } });
    for (const table of ["contracts", "contract_templates", "contract_template_versions"] as const) {
      expect((await anon.from(table).select("id")).error?.code).toBe("42501");
    }
    expect((await anon.rpc("contract_placeholder_catalog")).error?.code).toBe("42501");
    expect((await anon.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId })).error?.code).toBe("42501");
  });
});
