/**
 * Planning against the LOCAL stack, through the real API and roles: plans
 * created by real bookings (signing code, payments), truly concurrent
 * initialization, setup, starter installs and client saves, frozen imports
 * after catalog changes, a client working with two DJs, and REST-level
 * isolation. Dedicated test tenants, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { adminClient, bothSeparate, createEvent, createTenantWithCatalog, draftAndSend, must, openLink, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

const SECTIONS = [{ heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." }];
type Business = { catalog: Catalog; staff: Db; versionId: string };
type Client = { id: string; db: Db; email: string };

let admin: Db;
let a: Business;
let b: Business;
const tenants: string[] = [];

function signaturePng(): string {
  const w = 900, h = 300;
  const rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < 600; t++) {
    const x = 150 + t, y = Math.round(150 + Math.sin(t / 20) * 60);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${encodeRgbaPng(rgba, w, h).toString("base64")}`;
}

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const pay = (biz: Business, eventId: string, cents: number) =>
  biz.staff.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: cents, p_paid_on: yesterday(), p_reference: "IT-REF-SECRET", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
  });

async function business(prefix: string): Promise<Business> {
  const owner = await signedInUser(admin, `${prefix}-owner-${randomUUID().slice(0, 8)}@example.test`);
  const catalog = await createTenantWithCatalog(admin, owner.id, prefix);
  tenants.push(catalog.tenantId);
  const { data: templateId } = await must(owner.db.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT plan", p_title: "DEMO, NOT FOR CLIENT USE: Plan", p_sections: SECTIONS }));
  const { data: version } = await must(owner.db.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  await must(owner.db.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "demo" }));
  return { catalog, staff: owner.db, versionId: version!.id };
}

/** A signed contract for a verified client (new, or one who already has an account). Not booked yet (deposit policy). */
async function signedEvent(biz: Business, existing?: Client): Promise<{ eventId: string; contractId: string; deposit: number; client: Client }> {
  const email = existing?.email ?? `it-plan-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId } = await createEvent(admin, biz.catalog, email);
  const { proposalId, token } = await draftAndSend(biz.staff, biz.catalog, eventId);
  const { sessionHash } = await openLink(admin, biz.catalog.slug, token);
  const submitted = await submit(admin, { slug: biz.catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(biz.staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(biz.staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: biz.versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(biz.staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = existing ?? { ...(await signedInUser(admin, email)), email };
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: biz.catalog.slug }));
  const { data: row } = await must(admin.from("contracts").select("content_sha256, deposit_cents").eq("id", contractId).single());
  const signed = await signContractAs({
    userDb: client.db, userId: client.id, admin, slug: biz.catalog.slug, contractId,
    input: { typedName: "IT Planner", consentAccepted: true, consentVersion: "demo-v1", contentSha256: row!.content_sha256, signature: signaturePng() },
    request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
  });
  expect(signed).toMatchObject({ status: "signed" });
  // No PDF is needed here; retire the job so other suites' workers never wait behind it.
  const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
  for (const j of jobs ?? []) await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "planning test: PDF not needed", p_permanent: true });
  return { eventId, contractId, deposit: row!.deposit_cents, client };
}

const plans = async (eventId: string) => (await must(admin.from("event_plans").select("id, origin, initialized_via").eq("event_id", eventId))).data!;

describe("planning (local Supabase)", () => {
  let booked: Awaited<ReturnType<typeof signedEvent>>;

  beforeAll(async () => {
    admin = adminClient();
    a = await business("it-plan");
    b = await business("it-plan-b");
  }, 120_000);

  afterAll(async () => {
    for (const id of tenants) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", id);
  });

  it("concurrent payments and checks book once and create exactly one plan, with the frozen answers", async () => {
    booked = await signedEvent(a);
    expect(await plans(booked.eventId)).toHaveLength(0);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => pay(a, booked.eventId, booked.deposit)),
      ...Array.from({ length: 3 }, () => a.staff.rpc("check_event_booking", { p_event_id: booked.eventId })),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(await plans(booked.eventId)).toEqual([expect.objectContaining({ origin: "fallback", initialized_via: "booking" })]);
    const { data: audits } = await must(admin.from("audit_events").select("id").eq("entity_id", booked.eventId).eq("action", "planning_initialized"));
    expect(audits).toHaveLength(1);
    const { data: imports } = await must(admin.from("event_plan_imports").select("contract_id, questions, answers").eq("plan_id", (await plans(booked.eventId))[0].id));
    expect(imports).toHaveLength(1);
    expect(imports![0].contract_id).toBe(booked.contractId);
    expect((imports![0].questions as { key: string }[]).map((q) => q.key)).toEqual(["ceremony_location", "cocktail_location", "speeches_wireless_mic"]);
    expect(imports![0].answers).toEqual(bothSeparate);
  }, 120_000);

  it("re-running booking checks and setup never replaces the plan or its edits", async () => {
    const { data: view } = await must(a.staff.rpc("staff_planning_view", { p_event_id: booked.eventId }));
    const version = (view as { plan: { structure_version: number } }).plan.structure_version;
    await must(a.staff.rpc("add_event_plan_item", { p_event_id: booked.eventId, p_expected_version: version, p_key: "party", p_parent_key: null as unknown as string }));
    const again = await Promise.all([
      a.staff.rpc("check_event_booking", { p_event_id: booked.eventId }),
      a.staff.rpc("setup_event_plan", { p_event_id: booked.eventId, p_template_id: null as unknown as string }),
    ]);
    expect(again.every((r) => !r.error)).toBe(true);
    expect((again[1].data as { status: string }).status).toBe("exists");
    const { data: items } = await must(admin.from("event_plan_items").select("key").eq("plan_id", (await plans(booked.eventId))[0].id).order("key"));
    expect(items!.map((i) => i.key)).toEqual(["basics", "party"]);
  }, 60_000);

  it("concurrent setup before booking creates one plan; concurrent starter installs create one of each", async () => {
    const installs = await Promise.all(Array.from({ length: 4 }, () => a.staff.rpc("install_starter_planning_templates", { p_tenant_id: a.catalog.tenantId })));
    expect(installs.every((r) => !r.error)).toBe(true);
    const { data: templates } = await must(admin.from("planning_templates").select("id, starter_key").eq("tenant_id", a.catalog.tenantId));
    expect(templates!.map((t) => t.starter_key).sort()).toEqual(["simple_party", "wedding"]);
    const wedding = templates!.find((t) => t.starter_key === "wedding")!.id;

    const { eventId } = await createEvent(admin, a.catalog, `it-plan-early-${randomUUID().slice(0, 8)}@example.test`);
    const setups = await Promise.all(Array.from({ length: 6 }, () => a.staff.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding })));
    expect(setups.every((r) => !r.error)).toBe(true);
    expect(setups.map((r) => (r.data as { status: string }).status).sort()).toEqual(["created", "exists", "exists", "exists", "exists", "exists"]);
    expect(await plans(eventId)).toEqual([expect.objectContaining({ origin: "template", initialized_via: "staff" })]);
  }, 60_000);

  it("concurrent client saves with the same revision: exactly one wins, the others get a conflict", async () => {
    const saves = await Promise.all(
      [40, 50, 60, 70, 80].map((guests) =>
        booked.client.db.rpc("client_save_plan_basics", {
          p_event_id: booked.eventId, p_tenant_slug: a.catalog.slug, p_expected_revision: 0, p_answers: { guest_count: guests },
        }),
      ),
    );
    expect(saves.every((r) => !r.error)).toBe(true);
    const statuses = saves.map((r) => (r.data as { status: string }).status);
    expect(statuses.filter((s) => s === "saved")).toHaveLength(1);
    expect(statuses.filter((s) => s === "conflict")).toHaveLength(4);
    const winner = [40, 50, 60, 70, 80][statuses.indexOf("saved")];
    const { data: view } = await must(booked.client.db.rpc("client_planning_view", { p_event_id: booked.eventId, p_tenant_slug: a.catalog.slug }));
    expect((view as { basics: { answers: unknown; revision: number } }).basics).toEqual({ item_id: expect.any(String), answers: { guest_count: winner }, revision: 1 });
  }, 60_000);

  it("imported answers keep their frozen wording after catalog changes", async () => {
    await must(admin.from("logistics_questions").update({ prompt: "Reworded after signing" }).eq("tenant_id", a.catalog.tenantId).eq("key", "ceremony_location"));
    const { data: view } = await must(booked.client.db.rpc("client_planning_view", { p_event_id: booked.eventId, p_tenant_slug: a.catalog.slug }));
    const imported = (view as { imported: { questions: { key: string; prompt: string }[] } }).imported;
    expect(imported.questions.find((q) => q.key === "ceremony_location")!.prompt).toBe("Ceremony?");
    expect(JSON.stringify(view)).not.toMatch(/IT staff-only secret|IT-REF-SECRET/);
  }, 60_000);

  it("clients and other businesses get nothing through the API", async () => {
    const client = booked.client.db;
    for (const table of ["event_plans", "event_plan_items", "event_plan_responses", "event_plan_imports", "planning_templates", "planning_template_items"] as const) {
      const { data, error } = await client.from(table).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    expect((await client.rpc("staff_planning_view", { p_event_id: booked.eventId })).error?.code).toBe("P0002");
    expect((await client.rpc("setup_event_plan", { p_event_id: booked.eventId, p_template_id: null as unknown as string })).error?.code).toBe("P0002");
    const { error: insertError } = await client.from("event_plan_responses").insert({ tenant_id: a.catalog.tenantId, plan_id: randomUUID(), item_id: randomUUID(), updated_by_actor: "client" } as never);
    expect(insertError?.code).toBe("42501");

    expect((await b.staff.rpc("staff_planning_view", { p_event_id: booked.eventId })).error?.code).toBe("P0002");
    expect((await b.staff.from("event_plans").select("id").eq("event_id", booked.eventId)).data).toEqual([]);
    expect((await b.staff.from("planning_templates").select("id").eq("tenant_id", a.catalog.tenantId)).data).toEqual([]);
    const { data: other } = await must(b.staff.rpc("client_planning_view", { p_event_id: booked.eventId, p_tenant_slug: a.catalog.slug }));
    expect(other).toEqual({ state: "unavailable" });
  }, 60_000);

  it("a client of two DJs sees each plan under its DJ, and only their own", async () => {
    const second = await signedEvent(b, booked.client);
    await must(pay(b, second.eventId, second.deposit));
    const { data: mine } = await must(booked.client.db.rpc("my_plans"));
    expect(mine!.map((p) => [p.tenant_slug, p.event_id]).sort()).toEqual(
      [[a.catalog.slug, booked.eventId], [b.catalog.slug, second.eventId]].sort(),
    );
    const { data: wrongSlug } = await must(booked.client.db.rpc("client_planning_view", { p_event_id: second.eventId, p_tenant_slug: a.catalog.slug }));
    expect(wrongSlug).toEqual({ state: "unavailable" });
  }, 120_000);
});
