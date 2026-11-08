/**
 * Opening planning to the client (20261201000100) against the LOCAL stack,
 * through the real API and roles, with truly concurrent requests: several
 * staff opening at once open it exactly once; "Open planning & send
 * invitation" racing "Open without emailing" opens once and queues one
 * email; two first invitations at once both succeed, the later replacing the
 * earlier, with one opening; and a client reading or saving while staff open
 * it gets "setting up" or the plan, never a half-open state. Dedicated
 * it- tenant, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { planningInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, uuid } from "./support/sql";

const run = randomUUID().slice(0, 8);
let admin: Db;
let catalog: Catalog;
let owner: Db;
let staff: Db;
let client: { id: string; db: Db };

/** A booked event with planning set up (Event basics as chosen by staff), not opened; the client has verified access. */
async function bookedEvent(): Promise<string> {
  const { eventId, clientId } = await createEvent(admin, catalog, `it-activate-contact-${randomUUID().slice(0, 8)}@example.test`);
  await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, user_id: client.id }));
  await must(staff.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: null as unknown as string }));
  sql(`select set_config('flux.booking_event', ${uuid(eventId)}::text, false);
       update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ${uuid(eventId)};`);
  return eventId;
}
const invite = (db: Db, eventId: string) => {
  const id = randomUUID();
  return db.rpc("send_planning_invitation", { p_event_id: eventId, p_invitation_id: id, p_token_hash: sha256Hex(planningInviteToken(id)) });
};
const openings = async (eventId: string) =>
  (await must(admin.from("audit_events").select("id", { count: "exact", head: true }).eq("entity_id", eventId).eq("action", "planning_opened_to_client"))).count;
const view = async (eventId: string) =>
  ((await must(client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }))).data as { state: string });

beforeAll(async () => {
  admin = adminClient();
  const o = await signedInUser(admin, `it-activate-owner-${run}@example.test`);
  owner = o.db;
  catalog = await createTenantWithCatalog(admin, o.id, "it-activate");
  const s = await signedInUser(admin, `it-activate-staff-${run}@example.test`);
  await must(admin.from("tenant_memberships").insert({ tenant_id: catalog.tenantId, user_id: s.id, role: "staff" }));
  staff = s.db;
  client = await signedInUser(admin, `it-activate-${run}@example.test`);
}, 60_000);

afterAll(async () => {
  if (admin) await archiveTestTenants(admin, catalog?.tenantId);
});

describe("opening planning to the client (local Supabase)", () => {
  it("booking leaves planning closed; staff opening it at once open it exactly once", async () => {
    const eventId = await bookedEvent();
    expect((await view(eventId)).state).toBe("setting_up");
    const results = await Promise.all([owner, staff, owner, staff, owner, staff].map((db) => db.rpc("open_client_planning", { p_event_id: eventId })));
    expect(results.map((r) => r.error)).toEqual(Array(6).fill(null));
    const statuses = results.map((r) => (r.data as { status: string }).status).sort();
    expect(statuses).toEqual(["already_open", "already_open", "already_open", "already_open", "already_open", "opened"]);
    expect(await openings(eventId)).toBe(1);
    expect((await view(eventId)).state).toBe("available");
  }, 60_000);

  it("Open & send racing Open without emailing: opened once, one invitation and one queued email", async () => {
    const eventId = await bookedEvent();
    const [sent, ...opened] = await Promise.all([invite(owner, eventId), staff.rpc("open_client_planning", { p_event_id: eventId }), owner.rpc("open_client_planning", { p_event_id: eventId })]);
    expect([sent.error, ...opened.map((r) => r.error)]).toEqual([null, null, null]);
    const openedNow = [(sent.data as { opened: boolean }).opened, ...opened.map((r) => (r.data as { status: string }).status === "opened")];
    expect(openedNow.filter(Boolean)).toHaveLength(1);
    expect(await openings(eventId)).toBe(1);
    const { data: invitations } = await must(admin.from("planning_invitations").select("id").eq("event_id", eventId));
    expect(invitations).toHaveLength(1);
    const { count } = await must(admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("entity_id", invitations![0].id).eq("status", "pending"));
    expect(count).toBe(1);
  }, 60_000);

  it("two first invitations at once: both are recorded, the later replaces the earlier, and planning opens once", async () => {
    const eventId = await bookedEvent();
    const results = await Promise.all([invite(owner, eventId), invite(staff, eventId)]);
    expect(results.map((r) => r.error)).toEqual([null, null]);
    expect(results.map((r) => (r.data as { opened: boolean }).opened).sort()).toEqual([false, true]);
    expect(await openings(eventId)).toBe(1);
    const { data: invitations } = await must(admin.from("planning_invitations").select("revoked_at").eq("event_id", eventId));
    expect(invitations!.filter((i) => i.revoked_at === null)).toHaveLength(1);
    expect(invitations).toHaveLength(2);
  }, 60_000);

  it("a client reading and saving while staff open planning sees either 'setting up' or the plan, never anything in between", async () => {
    const eventId = await bookedEvent();
    const { data: item } = await must(admin.from("event_plan_items").select("id, event_plans!inner(event_id)").eq("event_plans.event_id", eventId).eq("key", "basics").single());
    const [, ...client_calls] = await Promise.all([
      owner.rpc("open_client_planning", { p_event_id: eventId }),
      client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }),
      client.db.rpc("client_save_plan_item", { p_event_id: eventId, p_tenant_slug: catalog.slug, p_item_id: item!.id, p_expected_revision: 0, p_answers: { guest_count: 75 } }),
    ]);
    expect(["setting_up", "available"]).toContain((client_calls[0].data as { state: string }).state);
    const save = client_calls[1].data as { status: string };
    expect(["unavailable", "saved"]).toContain(save.status);
    const { data: stored } = await must(admin.from("event_plan_responses").select("answers").eq("item_id", item!.id));
    // Refused saves store nothing; an accepted one is stored whole.
    expect(stored).toEqual(save.status === "saved" ? [{ answers: { guest_count: 75 } }] : []);
    expect((await view(eventId)).state).toBe("available");
  }, 60_000);
});
