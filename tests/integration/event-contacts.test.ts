/**
 * Event contacts against local Supabase with real staff sessions: concurrent
 * requests through PostgREST (separate connections, serialized by the event
 * lock in add_event_contact) and a generated contract that keeps its frozen
 * signer through contact changes. Access rules, refusals and rollback are in
 * pgTAP (51_event_contacts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { priceSelection } from "@/lib/pricing";
import {
  adminClient,
  archiveTestTenants,
  bothSeparate,
  clientView,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  must,
  openLink,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

let admin: Db;
let owner: Db;
let staff: Db;
let catalog: Catalog;

async function newClient(name: string): Promise<string> {
  const id = randomUUID();
  await must(admin.from("clients").insert({ id, tenant_id: catalog.tenantId, name, email: `it-ec-${randomUUID().slice(0, 8)}@example.test` }));
  return id;
}
async function roles(eventId: string) {
  const { data } = await must(admin.from("event_clients").select("client_id, is_primary, can_sign").eq("event_id", eventId));
  return {
    primary: data!.filter((r) => r.is_primary).map((r) => r.client_id),
    signer: data!.filter((r) => r.can_sign).map((r) => r.client_id),
    contacts: data!.map((r) => r.client_id),
  };
}

describe("event contacts (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const o = await signedInUser(admin, `it-ec-owner-${randomUUID().slice(0, 8)}@example.test`);
    owner = o.db;
    catalog = await createTenantWithCatalog(admin, o.id, "it-ec");
    const s = await signedInUser(admin, `it-ec-staff-${randomUUID().slice(0, 8)}@example.test`);
    await must(admin.from("tenant_memberships").insert({ tenant_id: catalog.tenantId, user_id: s.id, role: "staff" }));
    staff = s.db;
  });

  afterAll(async () => {
    await archiveTestTenants(admin, catalog?.tenantId);
  });

  it("two staff making different clients primary at once: one wins, the other changes nothing", async () => {
    const { eventId, clientId: original } = await createEvent(admin, catalog, `it-ec-race-${randomUUID().slice(0, 8)}@example.test`);
    const [a, b] = [await newClient("Race A"), await newClient("Race B")];
    const add = (db: Db, client: string) =>
      db.rpc("add_event_contact", { p_event_id: eventId, p_client_id: client, p_make_primary: true, p_make_signer: true, p_expected_primary_client_id: original });
    const results = await Promise.all([add(owner, a), add(staff, b)]);
    const ok = results.filter((r) => !r.error);
    const refused = results.filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].error!.code).toBe("PT409");
    const winner = results[0].error ? b : a;
    const loser = winner === a ? b : a;
    const now = await roles(eventId);
    expect(now.primary).toEqual([winner]);
    expect(now.signer).toEqual([winner]);
    expect(now.contacts).toContain(original);
    expect(now.contacts).not.toContain(loser);
  });

  it("the same client added twice at once: one contact, never a duplicate or a lost role", async () => {
    const { eventId, clientId: original } = await createEvent(admin, catalog, `it-ec-dup-${randomUUID().slice(0, 8)}@example.test`);
    const c = await newClient("Twice");
    const add = (db: Db) => db.rpc("add_event_contact", { p_event_id: eventId, p_client_id: c, p_make_primary: true, p_make_signer: true, p_expected_primary_client_id: original });
    const results = await Promise.all([add(owner), add(staff)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    // The second either finds the client already there or the primary already moved: both refusals change nothing.
    expect(results.find((r) => r.error)!.error!.message).toMatch(/contact_invalid|contact_conflict/);
    const now = await roles(eventId);
    expect(now.contacts.filter((x) => x === c)).toHaveLength(1);
    expect(now.primary).toEqual([c]);
    expect(now.signer).toEqual([c]);
  });

  it("a generated contract keeps its frozen signer when contacts change", async () => {
    const { eventId, clientId: signer } = await createEvent(admin, catalog, `it-ec-frozen-${randomUUID().slice(0, 8)}@example.test`);
    const { proposalId, token } = await draftAndSend(owner, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const input = { package_key: "signature", addons: { uplights_4: 1 }, answers: bothSeparate };
    const view = await clientView(admin, catalog.slug, proposalId, sessionHash);
    expect(priceSelection(view.offer!, input).ok).toBe(true);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input });
    const { data: approval } = await must(owner.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
    const { data: templateId } = await must(owner.rpc("create_contract_template", {
      p_tenant_id: catalog.tenantId, p_name: `IT EC ${randomUUID().slice(0, 6)}`, p_title: "DEMO, NOT FOR CLIENT USE: Agreement",
      p_sections: [{ heading: "Parties", body: "Between {{business.name}} and {{client.name}}. Total {{pricing.total}}." }],
    }));
    const { data: version } = await must(owner.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    await must(owner.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "demo" }));
    const { data: generated } = await must(owner.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: version!.id }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const frozen = async () =>
      (await must(admin.from("contracts").select("signer_client_id, signer_name, signer_email, party_snapshot, rendered_content, content_sha256, status").eq("id", contractId).single())).data;
    const before = await frozen();
    expect(before!.signer_client_id).toBe(signer);

    const next = await newClient("New signer");
    await must(owner.rpc("add_event_contact", { p_event_id: eventId, p_client_id: next, p_make_primary: true, p_make_signer: true, p_expected_primary_client_id: signer }));
    const { data: oldLink } = await must(admin.from("event_clients").select("id").eq("event_id", eventId).eq("client_id", signer).single());
    await must(owner.rpc("remove_event_contact", { p_event_id: eventId, p_event_client_id: oldLink!.id }));

    expect(await frozen()).toEqual(before);
    // The existing safeguard still applies: this draft names the old signer, so it can't be sent as it is.
    const { data: review } = await must(owner.rpc("review_contract_for_send", { p_contract_id: contractId }));
    expect((review as { problems: { code: string }[] }).problems.map((p) => p.code)).toContain("signer_changed");
  });
});
