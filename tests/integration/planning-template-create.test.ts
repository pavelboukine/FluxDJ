/**
 * Retry-safe planning template creation through the real PostgREST API,
 * signed in as the owner of a dedicated test tenant: the same request id
 * (a double submission, a retry after a lost response, many at once, or one
 * waiting on an uncommitted twin) always ends with one template; new ids
 * create new templates; other businesses can't create or claim one; and an
 * event plan already copied from a template doesn't change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, sqlInBackground, uuid } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let owner: { id: string; db: Db };
let other: { id: string; db: Db };
let otherCatalog: Catalog;
const tenants: string[] = [];

const create = (db: Db, tenantId: string, id: string, start: string, name: string, source: string | null = null) =>
  db.rpc("create_planning_template_once", {
    p_tenant_id: tenantId,
    p_template_id: id,
    p_start: start,
    p_source_template_id: source as string,
    p_name: name,
    p_description: null as unknown as string,
  });
const templatesWithId = async (id: string) => (await must(admin.from("planning_templates").select("id, name").eq("id", id))).data!;
const itemCount = async (id: string) => (await must(admin.from("planning_template_items").select("id").eq("template_id", id))).data!.length;
/** The Wedding starter's current outline size (it changes as planning evolves; a copy must match it exactly, never twice). */
const weddingStarterItems = () => Number(sql("select count(*) from private.starter_planning_items('wedding');"));

describe("planning template creation (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    owner = await signedInUser(admin, `it-ptc-owner-${randomUUID().slice(0, 8)}@example.test`);
    catalog = await createTenantWithCatalog(admin, owner.id, "it-ptc");
    tenants.push(catalog.tenantId);
    other = await signedInUser(admin, `it-ptc-other-${randomUUID().slice(0, 8)}@example.test`);
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-ptc-other");
    tenants.push(otherCatalog.tenantId);
  });

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  it("creates a template once; a double submission or a retry after a lost response returns it", async () => {
    const id = randomUUID();
    const first = await must(create(owner.db, catalog.tenantId, id, "wedding", "Wedding (French)"));
    expect(first.data).toEqual({ id, replayed: false });
    expect(await itemCount(id)).toBe(weddingStarterItems());
    // The response was lost; the browser sends the same form again (or the button was clicked twice).
    const retry = await must(create(owner.db, catalog.tenantId, id, "wedding", "Wedding (French)"));
    expect(retry.data).toEqual({ id, replayed: true });
    // The same id with other inputs returns the first template unchanged.
    const changed = await must(create(owner.db, catalog.tenantId, id, "basics", "Something else"));
    expect(changed.data).toEqual({ id, replayed: true });
    expect(await templatesWithId(id)).toEqual([{ id, name: "Wedding (French)" }]);
    expect(await itemCount(id)).toBe(weddingStarterItems());
  });

  it("ten identical requests at the same moment create one template", async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => create(owner.db, catalog.tenantId, id, "simple_party", "Birthday")));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect(await templatesWithId(id)).toHaveLength(1);
    expect(await itemCount(id)).toBe(4);
  });

  it("a request waits for an uncommitted identical one, then returns it", async () => {
    const id = randomUUID();
    const held = sqlInBackground(`begin;
      select set_config('request.jwt.claims', json_build_object('sub', ${uuid(owner.id)}::text, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select public.create_planning_template_once(${uuid(catalog.tenantId)}, ${uuid(id)}, 'basics', null, 'Held', null);
      select pg_sleep(1.5);
      commit;`);
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    const second = await must(create(owner.db, catalog.tenantId, id, "basics", "Held"));
    await held;
    expect(Date.now() - started).toBeGreaterThan(500); // it waited for the other transaction
    expect(second.data).toEqual({ id, replayed: true });
    expect(await templatesWithId(id)).toHaveLength(1);
  });

  it("new request ids create distinct templates, also with the same name", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await must(create(owner.db, catalog.tenantId, a, "basics", "Corporate"));
    await must(create(owner.db, catalog.tenantId, b, "copy", "Corporate", a));
    expect((await must(admin.from("planning_templates").select("id").in("id", [a, b]))).data).toHaveLength(2);
  });

  it("other businesses can't create here, claim an id, or copy across businesses", async () => {
    const mine = randomUUID();
    await must(create(owner.db, catalog.tenantId, mine, "basics", "Mine"));
    const here = await create(other.db, catalog.tenantId, randomUUID(), "basics", "Theirs");
    expect(here.error?.code).toBe("P0002");
    const claim = await create(other.db, otherCatalog.tenantId, mine, "basics", "Claim");
    expect(claim.error?.code).toBe("P0002");
    const copy = await create(other.db, otherCatalog.tenantId, randomUUID(), "copy", "Copy", mine);
    expect(copy.error?.code).toBe("P0002");
    expect(await templatesWithId(mine)).toEqual([{ id: mine, name: "Mine" }]);
  });

  it("an event plan copied from a template doesn't change when templates are created from it", async () => {
    const source = randomUUID();
    await must(create(owner.db, catalog.tenantId, source, "wedding", "Source"));
    const { eventId } = await createEvent(admin, catalog, `it-ptc-client-${randomUUID().slice(0, 8)}@example.test`);
    await must(owner.db.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: source }));
    const snapshot = async () =>
      (await must(admin.from("event_plans").select("id, source_template_id, structure_version, event_plan_items(id, key, label, position, disabled_at)").eq("event_id", eventId).single())).data!;
    const before = await snapshot();
    await must(create(owner.db, catalog.tenantId, randomUUID(), "copy", "Source (copy)", source));
    await must(create(owner.db, catalog.tenantId, source, "basics", "Retry of source"));
    expect(await snapshot()).toEqual(before);
  });
});
