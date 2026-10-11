/**
 * Retry-safe contract template creation through the real PostgREST API,
 * signed in as the owner of a dedicated test tenant: the same request id (a
 * double submission, a retry after a lost response, many at once, or one
 * waiting on an uncommitted twin) always ends with one template and one draft
 * version; new ids create new templates; other businesses can't create here
 * or claim an id; existing published versions and contracts don't change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sqlInBackground, uuid } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let owner: { id: string; db: Db };
let other: { id: string; db: Db };
let otherCatalog: Catalog;
const tenants: string[] = [];
const SECTIONS = [{ heading: "Parties", body: "{{business.legal_name}} and {{client.name}}." }];

const create = (db: Db, tenantId: string, id: string, name: string, title = "Agreement for {{event.title}}") =>
  db.rpc("create_contract_template_once", { p_tenant_id: tenantId, p_template_id: id, p_name: name, p_title: title, p_sections: SECTIONS });
const templates = async (id: string) => (await must(admin.from("contract_templates").select("id, name").eq("id", id))).data!;
const versions = async (id: string) => (await must(admin.from("contract_template_versions").select("version_number, title").eq("template_id", id))).data!;

describe("contract template creation (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    owner = await signedInUser(admin, `it-ctc-owner-${randomUUID().slice(0, 8)}@example.test`);
    catalog = await createTenantWithCatalog(admin, owner.id, "it-ctc");
    tenants.push(catalog.tenantId);
    other = await signedInUser(admin, `it-ctc-other-${randomUUID().slice(0, 8)}@example.test`);
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-ctc-other");
    tenants.push(otherCatalog.tenantId);
  });

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  it("creates a template once; a double submission or a retry after a lost response returns it", async () => {
    const id = randomUUID();
    expect((await must(create(owner.db, catalog.tenantId, id, "Wedding agreement"))).data).toEqual({ id, replayed: false });
    expect((await must(create(owner.db, catalog.tenantId, id, "Wedding agreement"))).data).toEqual({ id, replayed: true });
    // The same id with other inputs returns the first template unchanged.
    expect((await must(create(owner.db, catalog.tenantId, id, "Something else", "Other title"))).data).toEqual({ id, replayed: true });
    expect(await templates(id)).toEqual([{ id, name: "Wedding agreement" }]);
    expect(await versions(id)).toEqual([{ version_number: 1, title: "Agreement for {{event.title}}" }]);
  });

  it("ten identical requests at the same moment create one template", async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => create(owner.db, catalog.tenantId, id, "Parallel")));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect(await templates(id)).toHaveLength(1);
    expect(await versions(id)).toHaveLength(1);
  });

  it("a request waits for an uncommitted identical one, then returns it", async () => {
    const id = randomUUID();
    const held = sqlInBackground(`begin;
      select set_config('request.jwt.claims', json_build_object('sub', ${uuid(owner.id)}::text, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select public.create_contract_template_once(${uuid(catalog.tenantId)}, ${uuid(id)}, 'Held', 'Agreement', '[{"heading":"A","body":"B"}]'::jsonb);
      select pg_sleep(1.5);
      commit;`);
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    const second = await must(create(owner.db, catalog.tenantId, id, "Held"));
    await held;
    expect(Date.now() - started).toBeGreaterThan(500); // it waited for the other transaction
    expect(second.data).toEqual({ id, replayed: true });
    expect(await templates(id)).toHaveLength(1);
  });

  it("new request ids create distinct templates, also with the same name", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await must(create(owner.db, catalog.tenantId, a, "Same name"));
    await must(create(owner.db, catalog.tenantId, b, "Same name"));
    expect((await must(admin.from("contract_templates").select("id").in("id", [a, b]))).data).toHaveLength(2);
  });

  it("other businesses can't create here or claim an id; nothing existing changes", async () => {
    const mine = randomUUID();
    await must(create(owner.db, catalog.tenantId, mine, "Mine"));
    const publishedBefore = (await must(admin.from("contract_template_versions").select("id, content_sha256, title, sections").eq("tenant_id", catalog.tenantId).not("published_at", "is", null).order("id"))).data;
    expect((await create(other.db, catalog.tenantId, randomUUID(), "Theirs")).error?.code).toBe("P0002");
    expect((await create(other.db, otherCatalog.tenantId, mine, "Claim")).error?.code).toBe("P0002");
    expect(await templates(mine)).toEqual([{ id: mine, name: "Mine" }]);
    const publishedAfter = (await must(admin.from("contract_template_versions").select("id, content_sha256, title, sections").eq("tenant_id", catalog.tenantId).not("published_at", "is", null).order("id"))).data;
    expect(publishedAfter).toEqual(publishedBefore);
  });
});
