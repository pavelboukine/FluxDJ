/**
 * Settings -> configure taxes -> valid proposal preview, in a real browser
 * against local Supabase, inside a dedicated test tenant that starts with no
 * tax settings at all (like a newly bootstrapped hosted workspace).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const staffEmail = `e2e-tax-staff-${run}@example.test`;

test.describe.serial("tax settings", () => {
  let browser: Browser;
  let ownerContext: BrowserContext;
  let owner: Page;
  let eventId = "";
  let proposalUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("tax", { catalog: true });
    await admin.from("tenants").update({ tax_config: [], tax_categories: {} }).eq("id", tenant.id);
    const { data: member } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: member.user!.id, role: "staff" });

    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam & Alex", email: `sam-${run}@example.test` });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Tax Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });

    ownerContext = await browser.newContext();
    owner = await ownerContext.newPage();
    await signInStaff(owner, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("a missing mapping blocks the offer and links to Settings", async () => {
    await owner.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await owner.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
    await owner.getByRole("button", { name: "Start proposal draft" }).click();
    await owner.waitForURL("**/proposals/**");
    proposalUrl = owner.url();
    await expect(owner.getByText("tax categories not configured for this tenant: standard").first()).toBeVisible();
    await expect(owner.getByRole("button", { name: "Review and send…" })).toBeDisabled();
    await owner.getByRole("link", { name: "Open tax settings" }).first().click();
    await owner.waitForURL(`**/staff/${tenant.slug}/settings#taxes`);
    await expect(owner.getByRole("heading", { name: "Taxes" }).or(owner.getByText("Taxes", { exact: true })).first()).toBeVisible();
  });

  test("non-owner staff see the tax settings read-only", async () => {
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await signInStaff(staff, staffEmail);
    await staff.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" }).click();
    await expect(staff.getByText("Only the owner can change tax settings.")).toBeVisible();
    await expect(staff.getByText("Not configured: offers using it can't be sent.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Save tax settings" })).toHaveCount(0);
    await staffContext.close();
  });

  test("the owner configures exact rates and maps standard to two taxes", async () => {
    await owner.getByRole("button", { name: "Add tax" }).click();
    await owner.getByLabel("Tax 1 name").fill("GST");
    await owner.getByLabel("Tax 1 rate (%)").fill("5");
    await owner.getByRole("button", { name: "Add tax" }).click();
    await owner.getByLabel("Tax 2 name").fill("QST");
    await owner.getByLabel("Tax 2 rate (%)").fill("9.97501");
    const standard = owner.getByRole("group", { name: "Category standard" });
    await standard.getByLabel("Apply taxes").check();
    await standard.getByLabel("GST").check();
    await standard.getByLabel("QST").check();

    await owner.getByRole("button", { name: "Save tax settings" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "at most 4 decimals" })).toBeVisible();
    await owner.getByLabel("Tax 2 rate (%)").fill("9.975");
    await owner.getByRole("button", { name: "Save tax settings" }).click();
    await expect(owner.getByText(/Tax settings saved/)).toBeVisible();

    const { data } = await admin.from("tenants").select("tax_config, tax_categories, tax_settings_version").eq("id", tenant.id).single();
    expect(data).toEqual({
      tax_config: [
        { code: "GST", label: "GST", rate_ppm: 50_000 },
        { code: "QST", label: "QST", rate_ppm: 99_750 },
      ],
      tax_categories: { standard: ["GST", "QST"] },
      tax_settings_version: 2,
    });

    // Consecutive saves in the same tab use the returned version.
    await standard.getByLabel("QST").uncheck();
    await owner.getByRole("button", { name: "Save tax settings" }).click();
    await expect(owner.getByText(/Tax settings saved/)).toBeVisible();
    await expect.poll(async () => (await admin.from("tenants").select("tax_categories").eq("id", tenant.id).single()).data?.tax_categories).toEqual({
      standard: ["GST"],
    });
    await standard.getByLabel("QST").check();
    await owner.getByRole("button", { name: "Save tax settings" }).click();
    await expect(owner.getByText(/Tax settings saved/)).toBeVisible();
    await expect.poll(async () => (await admin.from("tenants").select("tax_settings_version").eq("id", tenant.id).single()).data?.tax_settings_version).toBe(4);
  });

  test("a stale tab cannot overwrite newer settings", async () => {
    const other = await ownerContext.newPage();
    await other.goto(`/staff/${tenant.slug}/settings`);
    await other.getByLabel("Tax 1 rate (%)").fill("6");
    await owner.reload();
    await owner.getByLabel("Tax 1 name").fill("TPS / GST");
    await owner.getByRole("button", { name: "Save tax settings" }).click();
    await expect(owner.getByText(/Tax settings saved/)).toBeVisible();
    await other.getByRole("button", { name: "Save tax settings" }).click();
    await expect(other.getByRole("alert").filter({ hasText: "Someone else saved changes first" })).toBeVisible();
    await other.close();
    const { data } = await admin.from("tenants").select("tax_config").eq("id", tenant.id).single();
    expect(data!.tax_config).toEqual([
      { code: "GST", label: "TPS / GST", rate_ppm: 50_000 },
      { code: "QST", label: "QST", rate_ppm: 99_750 },
    ]);
  });

  test("the proposal preview is now valid with both taxes", async () => {
    await owner.goto(proposalUrl);
    await expect(owner.getByText("tax categories not configured")).toHaveCount(0);
    await expect(owner.getByText("TPS / GST (5%)").first()).toBeVisible();
    await expect(owner.getByText("QST (9.975%)").first()).toBeVisible();
    await expect(owner.getByRole("button", { name: "Review and send…" })).toBeEnabled();
  });
});
