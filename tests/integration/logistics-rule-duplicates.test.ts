/**
 * Duplicate rule protection through the real PostgREST API, signed in as
 * the owner of a dedicated test tenant. Matching rules add their quantities,
 * so an identical active rule saved twice would silently double what
 * clients must take. Two submissions that both checked "no such rule yet"
 * (the app's check runs before its insert), many identical inserts at once,
 * a rule edited to copy another and a restored archived copy must all end
 * with exactly one active rule; distinct rules still add up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, sqlInBackground, uuid } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let owner: { id: string; db: Db };
let question = "";
const tenants: string[] = [];

const rule = (reason: string, quantity = 1, condition: unknown = { op: "equals", value: "separate_space" }) => ({
  tenant_id: catalog.tenantId,
  question_id: question,
  condition: condition as never,
  gear_item_id: catalog.gear.speaker,
  required_quantity: quantity,
  reason,
});
const activeCount = async (reason: string) =>
  (await must(admin.from("logistics_rules").select("id").eq("question_id", question).eq("reason", reason).eq("active", true))).data!.length;

describe("duplicate rules (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    owner = await signedInUser(admin, `it-rules-owner-${randomUUID().slice(0, 8)}@example.test`);
    catalog = await createTenantWithCatalog(admin, owner.id, "it-rules");
    tenants.push(catalog.tenantId);
    question = (await must(admin.from("logistics_questions").select("id").eq("tenant_id", catalog.tenantId).eq("key", "ceremony_location").single())).data!.id;
  });

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  it("two submissions that both passed the app's check: the second insert is refused", async () => {
    const reason = `Interleaved ${randomUUID()}`;
    // Both requests look first (as createRule does) and see no identical rule…
    const looks = await Promise.all([1, 2].map(() => owner.db.from("logistics_rules").select("id").eq("question_id", question).eq("reason", reason).eq("active", true)));
    expect(looks.every((l) => l.data!.length === 0)).toBe(true);
    // …then both insert.
    const first = await owner.db.from("logistics_rules").insert(rule(reason));
    const second = await owner.db.from("logistics_rules").insert(rule(reason));
    expect(first.error).toBeNull();
    expect(second.error?.code).toBe("23505");
    expect(second.error?.message).toMatch(/rule_duplicate/);
    expect(await activeCount(reason)).toBe(1);
  });

  it("ten identical inserts at the same moment leave exactly one active rule", async () => {
    const reason = `Parallel ${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => owner.db.from("logistics_rules").insert(rule(reason))));
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "23505")).toHaveLength(9);
    expect(await activeCount(reason)).toBe(1);
  });

  it("an insert waits for an uncommitted identical one, then is refused", async () => {
    const reason = `Held ${randomUUID()}`;
    const held = sqlInBackground(`begin;
      insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
      values (${uuid(catalog.tenantId)}, ${uuid(question)}, '{"op":"equals","value":"separate_space"}', ${uuid(catalog.gear.speaker)}, 1, '${reason}');
      select pg_sleep(1.5);
      commit;`);
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    const second = await owner.db.from("logistics_rules").insert(rule(reason));
    await held;
    expect(Date.now() - started).toBeGreaterThan(500); // it waited for the other transaction
    expect(second.error?.code).toBe("23505");
    expect(await activeCount(reason)).toBe(1);
  });

  it("“any of” in another order, or one value written either way, is the same rule", async () => {
    const reason = `Order ${randomUUID()}`;
    await must(owner.db.from("logistics_rules").insert(rule(reason, 1, { op: "in", values: ["same_room", "separate_space"] })));
    const reordered = await owner.db.from("logistics_rules").insert(rule(reason, 1, { op: "in", values: ["separate_space", "same_room"] }));
    expect(reordered.error?.code).toBe("23505");
    const single = `Single ${randomUUID()}`;
    await must(owner.db.from("logistics_rules").insert(rule(single)));
    const asIn = await owner.db.from("logistics_rules").insert(rule(single, 1, { op: "in", values: ["separate_space"] }));
    expect(asIn.error?.code).toBe("23505");
  });

  it("editing a rule into a copy of another, or restoring an archived copy, is refused", async () => {
    const reason = `Edit ${randomUUID()}`;
    await must(owner.db.from("logistics_rules").insert(rule(reason)));
    const { data: other } = await must(owner.db.from("logistics_rules").insert(rule(reason, 2)).select("id").single());
    const edit = await owner.db.from("logistics_rules").update({ required_quantity: 1 }).eq("id", other!.id);
    expect(edit.error?.code).toBe("23505");
    // Archiving it is fine; the archived copy may then match, but can't come back while the other is active.
    await must(owner.db.from("logistics_rules").update({ active: false }).eq("id", other!.id));
    await must(owner.db.from("logistics_rules").update({ required_quantity: 1 }).eq("id", other!.id));
    const restore = await owner.db.from("logistics_rules").update({ active: true }).eq("id", other!.id);
    expect(restore.error?.code).toBe("23505");
    expect(await activeCount(reason)).toBe(1);
    // Saving a rule unchanged is not a duplicate of itself.
    const { data: kept } = await must(admin.from("logistics_rules").select("id").eq("question_id", question).eq("reason", reason).eq("active", true).single());
    await must(owner.db.from("logistics_rules").update({ required_quantity: 1 }).eq("id", kept!.id));
  });

  it("distinct rules are still allowed and add up", async () => {
    const reason = `Distinct ${randomUUID()}`;
    await must(owner.db.from("logistics_rules").insert(rule(reason, 1)));
    await must(owner.db.from("logistics_rules").insert(rule(reason, 2)));
    await must(owner.db.from("logistics_rules").insert(rule(`${reason} (other reason)`, 1)));
    await must(owner.db.from("logistics_rules").insert(rule(reason, 1, { op: "equals", value: "same_room" })));
    const quantities = (await must(admin.from("logistics_rules").select("required_quantity").eq("question_id", question).like("reason", `${reason}%`).eq("active", true))).data!;
    expect(quantities.map((q) => q.required_quantity).sort()).toEqual([1, 1, 1, 2]);
  });

  it("duplicates saved before this protection are kept, and can be archived or made distinct", async () => {
    const reason = `Legacy ${randomUUID()}`;
    // Two identical active rules written as before the protection existed.
    sql(`set session_replication_role = replica;
      insert into public.logistics_rules (tenant_id, question_id, condition, gear_item_id, required_quantity, reason)
      select ${uuid(catalog.tenantId)}, ${uuid(question)}, '{"op":"equals","value":"separate_space"}', ${uuid(catalog.gear.speaker)}, 1, '${reason}'
      from generate_series(1, 2);`);
    expect(await activeCount(reason)).toBe(2);
    const { data: rows } = await must(admin.from("logistics_rules").select("id").eq("question_id", question).eq("reason", reason));
    // Editing one into something distinct works; so does archiving.
    await must(owner.db.from("logistics_rules").update({ reason: `${reason} (ceremony)` }).eq("id", rows![0].id));
    await must(owner.db.from("logistics_rules").update({ active: false }).eq("id", rows![1].id));
  });
});
