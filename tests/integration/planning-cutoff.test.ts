/**
 * Planning cutoff against the LOCAL stack, through the real API and roles,
 * with truly concurrent requests: a client save that waits on a lock across
 * the deadline, saves racing a staff "close now", two staff changing the
 * deadline or reopening at once, archiving racing reopening and saving, and
 * REST-level refusals for clients, anon and other businesses. Deadlines are
 * placed a few seconds away (never waited for in real time beyond that).
 * Dedicated test tenants, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, sqlInBackground, uuid } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let owner: Db;
let staff: Db;
let otherOwner: Db;
let client: { id: string; db: Db };
const tenants: string[] = [];

type Booked = { eventId: string; itemId: string };

/** A booked event (and so a plan) for the client; booking as evaluate_booking does it. */
async function bookedEvent(daysAhead: number): Promise<Booked> {
  const eventId = randomUUID();
  const clientId = randomUUID();
  const date = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  await must(admin.from("clients").insert({ id: clientId, tenant_id: catalog.tenantId, name: "IT Cutoff Client", email: `it-cutoff-${eventId.slice(0, 8)}@example.test` }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: catalog.tenantId, title: "IT cutoff wedding", event_type: "wedding", event_date: date, internal_notes: "IT CUTOFF SECRET" }));
  await must(admin.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, user_id: client.id }));
  sql(`select set_config('flux.booking_event', ${uuid(eventId)}::text, false);
       update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ${uuid(eventId)};`);
  const { data: item } = await must(admin.from("event_plan_items").select("id, event_plans!inner(event_id)").eq("event_plans.event_id", eventId).eq("key", "basics").single());
  return { eventId, itemId: item!.id };
}

/** Places the stored deadline (and reopening) relative to the database clock, as time passing would. */
function placeDeadline(eventId: string, lockIn: string, overrideIn: string | null = null) {
  sql(`select private.set_plan_cutoff_columns(${uuid(eventId)}, clock_timestamp() + interval '${lockIn}',
         ${overrideIn === null ? "null" : `clock_timestamp() + interval '${overrideIn}'`});`);
}

const revision = async (itemId: string) =>
  (await must(admin.from("event_plan_responses").select("revision, answers").eq("item_id", itemId).maybeSingle())).data ?? { revision: 0, answers: null };
const cutoffVersion = async (eventId: string) =>
  (await must(admin.from("event_plans").select("client_cutoff_version").eq("event_id", eventId).single())).data!.client_cutoff_version;
const save = (b: Booked, rev: number, answers: { [key: string]: number | string | boolean }, db: Db = client.db) =>
  db.rpc("client_save_plan_item", { p_event_id: b.eventId, p_tenant_slug: catalog.slug, p_item_id: b.itemId, p_expected_revision: rev, p_answers: answers });
const localIn = (ms: number, tz = "America/Toronto") => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(Date.now() + ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
};

describe("planning cutoff (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const o = await signedInUser(admin, `it-cutoff-owner-${randomUUID().slice(0, 8)}@example.test`);
    owner = o.db;
    catalog = await createTenantWithCatalog(admin, o.id, "it-cutoff");
    tenants.push(catalog.tenantId);
    const s = await signedInUser(admin, `it-cutoff-staff-${randomUUID().slice(0, 8)}@example.test`);
    await must(admin.from("tenant_memberships").insert({ tenant_id: catalog.tenantId, user_id: s.id, role: "staff" }));
    staff = s.db;
    const ob = await signedInUser(admin, `it-cutoff-other-${randomUUID().slice(0, 8)}@example.test`);
    const otherCatalog = await createTenantWithCatalog(admin, ob.id, "it-cutoff-b");
    tenants.push(otherCatalog.tenantId);
    otherOwner = ob.db;
    client = await signedInUser(admin, `it-cutoff-client-${randomUUID().slice(0, 8)}@example.test`);
  }, 120_000);

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  it("refuses a save that waited on a lock across the deadline, using database time after the lock", async () => {
    const b = await bookedEvent(90);
    placeDeadline(b.eventId, "2 seconds");
    // Another session holds the event (as a staff deadline change or archiving would) past the deadline.
    const holder = sqlInBackground(`begin; select 1 from public.events where id = ${uuid(b.eventId)} for no key update; select pg_sleep(3.5); commit;`);
    await new Promise((r) => setTimeout(r, 700));
    const started = Date.now();
    const { data } = await save(b, 0, { guest_count: 140 });
    expect(Date.now() - started).toBeGreaterThan(1500); // it really waited
    await holder;
    expect(data).toMatchObject({ status: "locked", editing: { state: "closed", closes_at: null } });
    expect(await revision(b.itemId)).toEqual({ revision: 0, answers: null });
  }, 30_000);

  it("still saves after a lock wait that ends before the deadline", async () => {
    const b = await bookedEvent(90);
    placeDeadline(b.eventId, "30 seconds");
    const holder = sqlInBackground(`begin; select 1 from public.events where id = ${uuid(b.eventId)} for no key update; select pg_sleep(1.5); commit;`);
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await save(b, 0, { guest_count: 140 });
    await holder;
    expect(data).toMatchObject({ status: "saved", revision: 1 });
  }, 30_000);

  it("after the deadline: the client reads but every write path is refused, with client-safe fields only", async () => {
    const b = await bookedEvent(90);
    await must(save(b, 0, { guest_count: 100 }));
    placeDeadline(b.eventId, "-1 second");
    const { data: view } = await must(client.db.rpc("client_planning_view", { p_event_id: b.eventId, p_tenant_slug: catalog.slug }));
    expect(view).toMatchObject({ state: "available", editing: { state: "closed" }, basics: { answers: { guest_count: 100 } } });
    const item = await save(b, 1, { guest_count: 101 });
    const basics = await client.db.rpc("client_save_plan_basics", { p_event_id: b.eventId, p_tenant_slug: catalog.slug, p_expected_revision: 1, p_answers: { guest_count: 102 } });
    for (const r of [item.data, basics.data]) {
      expect(r).toMatchObject({ status: "locked" });
      expect(Object.keys(r as object).sort()).toEqual(["editing", "status"]);
      expect(Object.keys((r as { editing: object }).editing).sort()).toEqual(["closes_at", "deadline", "state", "timezone"]);
    }
    expect(await revision(b.itemId)).toEqual({ revision: 1, answers: { guest_count: 100 } });
    // Staff still edit.
    const { data: staffSave } = await must(staff.rpc("staff_save_plan_item", { p_event_id: b.eventId, p_item_id: b.itemId, p_expected_revision: 1, p_answers: { guest_count: 110 } }));
    expect(staffSave).toMatchObject({ status: "saved", revision: 2 });
    // No direct route around the functions.
    const direct = [
      await client.db.from("events").update({ planning_override_until: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", b.eventId).select("id"),
      await staff.from("events").update({ planning_override_until: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", b.eventId).select("id"),
      await staff.from("events").update({ planning_lock_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", b.eventId).select("id"),
      await staff.from("event_plan_responses").update({ answers: { guest_count: 1 } }).eq("item_id", b.itemId).select("id"),
      await owner.from("tenants").update({ planning_lock_days: 1 }).eq("id", catalog.tenantId).select("id"),
    ];
    for (const r of direct) expect(r.error ?? (r.data?.length === 0 ? "no rows" : null)).toBeTruthy();
    const reopenByClient = await client.db.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: 1, p_until_local: localIn(86_400_000), p_reason: "self" });
    expect(reopenByClient.error).toBeTruthy();
    const reopenByOther = await otherOwner.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: 1, p_until_local: localIn(86_400_000), p_reason: "x" });
    expect(reopenByOther.error?.code).toBe("P0002");
    expect((await revision(b.itemId)).answers).toEqual({ guest_count: 110 });
  }, 30_000);

  it("reopens and expires by database time, then refuses again", async () => {
    const b = await bookedEvent(90);
    placeDeadline(b.eventId, "-1 hour");
    const v = await cutoffVersion(b.eventId);
    const { data: reopened } = await must(staff.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v, p_until_local: localIn(3_000), p_reason: "Quick fix" }));
    expect(reopened).toMatchObject({ status: "reopened" });
    const { data: during } = await must(save(b, 0, { guest_count: 77 }));
    expect(during).toMatchObject({ status: "saved" });
    await new Promise((r) => setTimeout(r, 3_500));
    const { data: after } = await must(save(b, 1, { guest_count: 78 }));
    expect(after).toMatchObject({ status: "locked" });
    expect((await revision(b.itemId)).answers).toEqual({ guest_count: 77 });
  }, 30_000);

  it("a save racing 'close client editing now' either commits fully or changes nothing", async () => {
    for (let round = 0; round < 4; round++) {
      const b = await bookedEvent(90);
      placeDeadline(b.eventId, "-1 hour", "1 day");
      const v = await cutoffVersion(b.eventId);
      const [saved, closed] = await Promise.all([
        save(b, 0, { guest_count: 200 + round }),
        staff.rpc("close_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v, p_reason: "Race" }),
      ]);
      expect(closed.data).toMatchObject({ status: "closed" });
      const stored = await revision(b.itemId);
      if ((saved.data as { status: string }).status === "saved") expect(stored).toEqual({ revision: 1, answers: { guest_count: 200 + round } });
      else {
        expect(saved.data).toMatchObject({ status: "locked" });
        expect(stored).toEqual({ revision: 0, answers: null });
      }
      expect((await save(b, stored.revision, { guest_count: 1 })).data).toMatchObject({ status: "locked" });
    }
  }, 60_000);

  it("two staff changing the deadline or reopening at once: one wins, the other conflicts, one audit each", async () => {
    const b = await bookedEvent(90);
    const v = await cutoffVersion(b.eventId);
    const days = await Promise.all([
      staff.rpc("set_plan_client_cutoff", { p_event_id: b.eventId, p_expected_version: v, p_days: 20, p_reason: "Staff tab" }),
      owner.rpc("set_plan_client_cutoff", { p_event_id: b.eventId, p_expected_version: v, p_days: 30, p_reason: "Owner tab" }),
    ]);
    expect(days.filter((r) => !r.error)).toHaveLength(1);
    expect(days.filter((r) => r.error?.code === "40001")).toHaveLength(1);
    const { data: audits } = await must(admin.from("audit_events").select("id").eq("entity_id", b.eventId).eq("action", "planning_cutoff_changed"));
    expect(audits).toHaveLength(1);

    placeDeadline(b.eventId, "-1 hour");
    const v2 = await cutoffVersion(b.eventId);
    const reopen = await Promise.all([
      staff.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v2, p_until_local: localIn(86_400_000), p_reason: "A" }),
      owner.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v2, p_until_local: localIn(2 * 86_400_000), p_reason: "B" }),
    ]);
    expect(reopen.filter((r) => !r.error)).toHaveLength(1);
    expect(reopen.filter((r) => r.error?.code === "40001")).toHaveLength(1);
    // The same request repeated (a double click) is one reopening.
    const until = localIn(3 * 86_400_000);
    const v3 = await cutoffVersion(b.eventId);
    const twice = await Promise.all([1, 2].map(() => staff.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v3, p_until_local: until, p_reason: "Same" })));
    expect(twice.map((r) => (r.data as { status: string }).status).sort()).toEqual(["reopened", "unchanged"]);
    const { data: reopenAudits } = await must(admin.from("audit_events").select("id").eq("entity_id", b.eventId).eq("action", "planning_client_reopened"));
    expect(reopenAudits).toHaveLength(2);
  }, 30_000);

  it("archiving racing a reopening and a save leaves the client with nothing", async () => {
    const b = await bookedEvent(90);
    placeDeadline(b.eventId, "-1 hour");
    const v = await cutoffVersion(b.eventId);
    const [archived, reopened, saved] = await Promise.all([
      staff.rpc("set_event_archived", { p_event_id: b.eventId, p_archived: true }),
      owner.rpc("reopen_plan_client_editing", { p_event_id: b.eventId, p_expected_version: v, p_until_local: localIn(86_400_000), p_reason: "Race" }),
      save(b, 0, { guest_count: 5 }),
    ]);
    expect(archived.error).toBeNull();
    if (reopened.error) expect(reopened.error.message).toMatch(/archived/);
    expect(["locked", "unavailable", "saved"]).toContain((saved.data as { status: string }).status);
    expect((await save(b, (await revision(b.itemId)).revision, { guest_count: 6 })).data).toMatchObject({ status: "unavailable" });
    const { data: view } = await must(client.db.rpc("client_planning_view", { p_event_id: b.eventId, p_tenant_slug: catalog.slug }));
    expect(view).toEqual({ state: "unavailable" });
  }, 30_000);

  it("anon can't call any of it", async () => {
    const env = (await import("./support/fixtures")).localStatus();
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } });
    for (const [fn, args] of [
      ["client_save_plan_item", { p_event_id: randomUUID(), p_tenant_slug: catalog.slug, p_item_id: randomUUID(), p_expected_revision: 0, p_answers: {} }],
      ["reopen_plan_client_editing", { p_event_id: randomUUID(), p_expected_version: 1, p_until_local: localIn(1000), p_reason: "x" }],
      ["update_planning_cutoff_days", { p_tenant_id: catalog.tenantId, p_days: 1, p_expected_version: 0 }],
    ] as const) {
      const r = await anon.rpc(fn as never, args as never);
      expect(r.error).toBeTruthy();
    }
  });
});
