/**
 * Stale-version requests through the real PostgREST HTTP API, signed in as
 * the business owner of a dedicated test tenant: each must answer promptly
 * with HTTP 409 and code PT409, write nothing, and leave no retry loop of
 * rolled-back transactions behind (PostgREST v14 retried the old 40001 code
 * until the client gave up).
 *
 * Always runs against the local stack's API. To also check another PostgREST
 * version on the same database, set FLUX_REST_V14_URL to its root (see
 * README, "Local Supabase versions").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminClient, archiveTestTenants, createTenantWithCatalog, localStatus, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let owner: { id: string; db: Db };
let token = "";
let eventId = "";
let planItem = "";
let templateItem = "";
let contractTemplateVersion = "";
const tenants: string[] = [];

const env = localStatus();
const targets: [string, string][] = [["local API", `${env.API_URL}/rest/v1`]];
if (process.env.FLUX_REST_V14_URL) targets.push(["FLUX_REST_V14_URL", process.env.FLUX_REST_V14_URL.replace(/\/$/, "")]);

const rollbacks = () => Number(sql("select xact_rollback from pg_stat_database where datname = 'postgres'"));

async function rpc(base: string, fn: string, args: Record<string, unknown>) {
  const started = Date.now();
  const res = await fetch(`${base}/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; message?: string }, ms: Date.now() - started };
}

describe("version conflicts answer at once (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    owner = await signedInUser(admin, `it-conflict-owner-${randomUUID().slice(0, 8)}@example.test`);
    catalog = await createTenantWithCatalog(admin, owner.id, "it-conflict");
    tenants.push(catalog.tenantId);
    token = (await owner.db.auth.getSession()).data.session!.access_token;

    eventId = randomUUID();
    await must(admin.from("events").insert({ id: eventId, tenant_id: catalog.tenantId, title: "IT conflict wedding", event_type: "wedding", event_date: "2027-09-01" }));
    await must(owner.db.rpc("install_starter_planning_templates", { p_tenant_id: catalog.tenantId }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", catalog.tenantId).eq("starter_key", "wedding").single());
    await must(owner.db.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    planItem = plan!.event_plan_items.find((i: { key: string }) => i.key === "cocktail")!.id;
    const { data: ti } = await must(admin.from("planning_template_items").select("id").eq("template_id", wedding!.id).eq("key", "party").single());
    templateItem = ti!.id;
    const { data: templateId } = await must(owner.db.rpc("create_contract_template", {
      p_tenant_id: catalog.tenantId, p_name: "IT conflict", p_title: "DEMO, NOT FOR CLIENT USE: Conflict", p_sections: [{ heading: "Terms", body: "Total {{pricing.total}}." }],
    }));
    const { data: version } = await must(admin.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    contractTemplateVersion = version!.id;
  }, 120_000);

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  for (const [name, base] of targets) {
    it(`${name}: stale versions get 409 PT409 promptly, write nothing and leave no retry loop`, async () => {
      const before = {
        tenant: (await must(admin.from("tenants").select("booking_confirmation_policy, booking_policy_version, tax_settings_version, planning_lock_days, planning_settings_version").eq("id", catalog.tenantId).single())).data,
        plan: (await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single())).data,
        item: (await must(admin.from("event_plan_items").select("disabled_at").eq("id", planItem).single())).data,
        templateItem: (await must(admin.from("planning_template_items").select("label").eq("id", templateItem).single())).data,
        draft: (await must(admin.from("contract_template_versions").select("draft_version, title").eq("id", contractTemplateVersion).single())).data,
      };
      const t = before.tenant!;
      const calls: [string, Record<string, unknown>][] = [
        ["update_booking_policy", { p_tenant_id: catalog.tenantId, p_policy: "on_signature", p_expected_version: t.booking_policy_version + 7 }],
        ["update_tax_settings", { p_tenant_id: catalog.tenantId, p_expected_version: t.tax_settings_version + 7, p_tax_config: [], p_tax_categories: { standard: [] } }],
        ["update_planning_cutoff_days", { p_tenant_id: catalog.tenantId, p_days: 3, p_expected_version: t.planning_settings_version + 7 }],
        ["set_event_plan_item_enabled", { p_item_id: planItem, p_expected_version: before.plan!.structure_version + 7, p_enabled: false }],
        ["rename_planning_template_item", { p_item_id: templateItem, p_expected_version: 999, p_label: "Stale rename" }],
        ["save_contract_template_draft", { p_version_id: contractTemplateVersion, p_expected_draft_version: before.draft!.draft_version + 7, p_title: "Stale title", p_sections: [{ heading: "Stale", body: "x" }] }],
      ];
      const start = rollbacks();
      for (const [fn, args] of calls) {
        const r = await rpc(base, fn, args);
        expect({ fn, status: r.status, code: r.body.code }).toEqual({ fn, status: 409, code: "PT409" });
        expect(r.ms, fn).toBeLessThan(2000);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // A handful of rollbacks (the refused calls themselves); a retry loop would add thousands.
      expect(rollbacks() - start).toBeLessThan(50);
      expect({
        tenant: (await must(admin.from("tenants").select("booking_confirmation_policy, booking_policy_version, tax_settings_version, planning_lock_days, planning_settings_version").eq("id", catalog.tenantId).single())).data,
        plan: (await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single())).data,
        item: (await must(admin.from("event_plan_items").select("disabled_at").eq("id", planItem).single())).data,
        templateItem: (await must(admin.from("planning_template_items").select("label").eq("id", templateItem).single())).data,
        draft: (await must(admin.from("contract_template_versions").select("draft_version, title").eq("id", contractTemplateVersion).single())).data,
      }).toEqual(before);
    });
  }

  it("a current version still saves (the check refuses only stale ones)", async () => {
    const { data: t } = await must(admin.from("tenants").select("booking_policy_version").eq("id", catalog.tenantId).single());
    const r = await rpc(targets[0][1], "update_booking_policy", { p_tenant_id: catalog.tenantId, p_policy: "on_signature", p_expected_version: t!.booking_policy_version });
    expect(r.status).toBe(200);
    expect((await must(admin.from("tenants").select("booking_confirmation_policy").eq("id", catalog.tenantId).single())).data!.booking_confirmation_policy).toBe("on_signature");
  });
});
