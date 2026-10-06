/**
 * Manual payments through the real API (PostgREST + RLS) against the LOCAL
 * stack: truly concurrent submissions, client writes, and other tenants.
 * Dedicated test tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

let admin: Db;
let staff: Db;
let catalog: Catalog;
let otherStaff: Db;
let client: Db;
let eventId: string;

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const record = (db: Db, amount: number, key = randomUUID(), confirm = false) =>
  db.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: amount, p_paid_on: yesterday(), p_reference: "", p_note: "", p_idempotency_key: key, p_confirm_duplicate: confirm,
  });
const validPayments = async () =>
  (await must(admin.from("event_payments").select("id, amount_cents").eq("event_id", eventId).is("invalidated_at", null))).data!;

let otherTenantId: string | undefined;

describe("manual payments (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-pay-owner-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-pay");
    const clientEmail = `it-pay-client-${randomUUID().slice(0, 8)}@example.test`;
    ({ eventId } = await createEvent(admin, catalog, clientEmail));
    client = (await signedInUser(admin, clientEmail)).db;
    const other = await signedInUser(admin, `it-pay-other-${randomUUID().slice(0, 8)}@example.test`);
    otherTenantId = (await createTenantWithCatalog(admin, other.id, "it-pay-b")).tenantId;
    otherStaff = other.db;
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherTenantId);
  });

  it("records one payment when the same submission arrives several times at once", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => record(staff, 12_345, key)));
    expect(results.every((r) => !r.error)).toBe(true);
    const statuses = results.map((r) => (r.data as { status: string }).status).sort();
    expect(statuses.filter((s) => s === "recorded")).toHaveLength(1);
    expect(statuses.filter((s) => s === "replayed")).toHaveLength(5);
    expect((await validPayments()).filter((p) => p.amount_cents === 12_345)).toHaveLength(1);
  });

  it("two different submissions of the same amount and date at once record one; the other asks for confirmation", async () => {
    const [a, b] = await Promise.all([record(staff, 777), record(staff, 777)]);
    const errors = [a, b].filter((r) => r.error).map((r) => r.error!.message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/payment_possible_duplicate/);
    expect((await validPayments()).filter((p) => p.amount_cents === 777)).toHaveLength(1);
    // Confirmed as a separate payment, it is recorded.
    await must(record(staff, 777, randomUUID(), true));
    expect((await validPayments()).filter((p) => p.amount_cents === 777)).toHaveLength(2);
  });

  it("clients and other tenants can't record, change, invalidate or read payments", async () => {
    const [first] = await validPayments();
    for (const db of [client, otherStaff]) {
      expect((await record(db, 100)).error?.message).toMatch(/not found/);
      expect((await db.rpc("invalidate_event_payment", { p_payment_id: first.id, p_reason: "not allowed" })).error).toBeTruthy();
      expect((await db.from("event_payments").insert({ tenant_id: catalog.tenantId, event_id: eventId, amount_cents: 1, currency: "CAD", paid_on: yesterday(), idempotency_key: randomUUID(), recorded_by_user_id: randomUUID() })).error).toBeTruthy();
      await db.from("event_payments").update({ invalidated_at: new Date().toISOString() }).eq("id", first.id);
      expect((await db.from("event_payments").select("id").eq("event_id", eventId)).data ?? []).toEqual([]);
      expect((await db.rpc("set_event_invoice_url", { p_event_id: eventId, p_invoice_url: "https://evil.example.com/", p_expected_version: 0 })).error).toBeTruthy();
    }
    const { data: row } = await must(admin.from("event_payments").select("invalidated_at").eq("id", first.id).single());
    expect(row!.invalidated_at).toBeNull();
    expect(await validPayments()).toHaveLength(3);
  });
});
