/**
 * The setup guide (/staff/{tenant}/setup) and the regrouped Business settings,
 * in dedicated test businesses: a new workspace whose steps follow what's
 * saved through the real Settings and planning template screens, a staff
 * member's read-only view, an established business that is never pushed
 * into setup, another business's guide refused, a suspended workspace, and
 * a 320 px phone with keyboard use. Setup status is derived from saved data
 * only (unit-tested in tests/unit/setup.test.ts).
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";

const run = randomUUID().slice(0, 6);
const NARROW = { viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true };

async function shot(page: Page, info: TestInfo, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const task = (page: Page, key: string) => page.getByTestId(`setup-task-${key}`);

async function ok<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

test.describe.serial("setup guide and business settings", () => {
  let browser: Browser;
  let fresh: TestTenant;
  let established: TestTenant;
  let suspended: TestTenant;
  const staffEmail = `e2e-setup-staff-${run}@example.test`;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    // As a new invited workspace starts: legal identity unconfirmed, no taxes, no logo, nothing in the catalog.
    fresh = await createTestTenant("setup-new");
    await ok(admin.from("tenants").update({ business_address: null, contact_email: null, tax_config: [], tax_categories: {}, brand_colors: {} }).eq("id", fresh.id));
    const { data: staffUser } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await ok(admin.from("tenant_memberships").insert({ tenant_id: fresh.id, user_id: staffUser.user!.id, role: "staff" }));

    // An established business: catalog, proposal template and a contract published for client use.
    established = await createTestTenant("setup-est", { catalog: true });
    const templateId = randomUUID();
    const versionId = randomUUID();
    await ok(admin.from("contract_templates").insert({ id: templateId, tenant_id: established.id, name: "Wedding agreement" }));
    await ok(admin.from("contract_template_versions").insert({ id: versionId, tenant_id: established.id, template_id: templateId, version_number: 1, title: "Wedding DJ agreement", sections: [{ heading: "Services", body: "The DJ performs." }] }));
    const { data: owner } = await admin.from("tenant_memberships").select("user_id").eq("tenant_id", established.id).eq("role", "owner").single();
    // Published for client use as the owner's confirmation records it (the editor is covered by contract-flow.spec.ts).
    const { data: statement } = await admin.rpc("client_use_statement_current");
    await ok(admin.from("contract_template_versions").update({
      published_at: new Date().toISOString(), usage: "client_use", client_use_statement_version: (statement as { version: string }).version,
      client_use_confirmed_by_user_id: owner!.user_id,
    }).eq("id", versionId));

    suspended = await createTestTenant("setup-susp");
  });

  test.afterAll(async () => {
    await archiveTestTenant(fresh);
    await archiveTestTenant(established);
    await archiveTestTenant(suspended);
  });

  test("a new business: steps follow what is saved, with a way back from each page", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(page, fresh.ownerEmail);
    await page.goto(`/staff/${fresh.slug}`);
    await page.getByTestId("setup-checklist").getByRole("link", { name: "Continue setup" }).click();
    await page.waitForURL(`**/staff/${fresh.slug}/setup`);
    await expect(page.getByRole("heading", { level: 1, name: "Let's get your business ready" })).toBeVisible();
    await expect(page.getByTestId("workspace-brand")).toContainText(fresh.displayName);
    await expect(page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("setup-progress")).toHaveText("0 of 4 required steps ready");
    await expect(page.getByTestId("ready-proposals")).toContainText("Still needs: Taxes, Three packages.");

    // Required, recommended and optional steps, each linking to its existing page.
    const expected: [string, string, string][] = [
      ["identity", "not_started", `/staff/${fresh.slug}/settings?from=setup`],
      ["branding", "optional", `/staff/${fresh.slug}/settings?from=setup#branding`],
      ["booking", "not_started", `/staff/${fresh.slug}/settings?from=setup#booking`],
      ["taxes", "not_started", `/staff/${fresh.slug}/settings?from=setup#taxes`],
      ["gear", "optional", `/staff/${fresh.slug}/gear?from=setup`],
      ["packages", "not_started", `/staff/${fresh.slug}/packages?from=setup`],
      ["proposal-template", "not_started", `/staff/${fresh.slug}/templates?from=setup`],
      ["questions", "optional", `/staff/${fresh.slug}/questions?from=setup`],
      ["contract-template", "not_started", `/staff/${fresh.slug}/contract-templates?from=setup`],
      ["planning", "not_started", `/staff/${fresh.slug}/planning-templates?from=setup`],
      ["first-event", "optional", `/staff/${fresh.slug}/events/new?from=setup`],
    ];
    for (const [key, status, href] of expected) {
      await expect(task(page, key)).toHaveAttribute("data-status", status);
      await expect(task(page, key).getByRole("link")).toHaveAttribute("href", href);
    }
    await expect(task(page, "branding")).toContainText("Optional");
    await expect(task(page, "branding")).toContainText("Add your logo or choose a brand colour.");
    await expect(task(page, "proposal-template")).toContainText("Recommended");
    await expect(task(page, "packages")).toContainText("Needed to send proposals");
    await shot(page, info, "setup-new-desktop");

    // Business details through the regrouped Settings page, then back.
    await task(page, "identity").getByRole("link").click();
    await page.waitForURL(`**/staff/${fresh.slug}/settings?from=setup`);
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link")).toHaveText(["Business profile", "Branding", "Bookings and taxes", "Planning", "Access"]);
    await expect(page.getByLabel("Legal business name")).toHaveValue("");
    await page.getByLabel("Legal business name").fill("E2E Setup Sound Inc.");
    await page.getByLabel("Business address").fill("2 Setup Street, Montréal, QC");
    await page.getByLabel("Contact email").fill(`setup-${run}@example.test`);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.", { exact: false })).toBeVisible();
    await page.getByTestId("setup-return").click();
    await page.waitForURL(`**/staff/${fresh.slug}/setup`);
    await expect(task(page, "identity")).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("setup-progress")).toHaveText("1 of 4 required steps ready");
    // The deposit was saved with the legal details; the booking policy is still the untouched default.
    await expect(task(page, "booking")).toHaveAttribute("data-status", "attention");
    await expect(task(page, "booking")).toContainText("Not reviewed yet.");

    await task(page, "booking").getByRole("link").click();
    await page.waitForURL(`**/settings?from=setup#booking`);
    await expect(page.getByTestId("deposit-summary")).toContainText("50%");
    await page.getByRole("button", { name: "Save booking policy" }).click();
    await expect(page.getByText("Booking policy saved.", { exact: false })).toBeVisible();
    await page.getByTestId("setup-return").click();
    await expect(task(page, "booking")).toHaveAttribute("data-status", "ready");

    // Planning: starter templates first (no default yet), then a default for weddings.
    await task(page, "planning").getByRole("link").click();
    await page.waitForURL(`**/planning-templates?from=setup`);
    await expect(page.getByTestId("setup-return")).toBeVisible();
    await page.getByRole("button", { name: "Add starter templates" }).click();
    await expect(page.getByTestId("planning-template-row")).toHaveCount(2);
    await page.goto(`/staff/${fresh.slug}/setup`);
    await expect(task(page, "planning")).toHaveAttribute("data-status", "attention");
    await expect(task(page, "planning")).toContainText("2 templates, not yet the default for any event type.");
    await page.goto(`/staff/${fresh.slug}/planning-templates`);
    await page.getByRole("link", { name: "Open Wedding", exact: true }).click();
    await page.getByLabel("Default for event type").selectOption("wedding");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect.poll(async () => (await admin.from("planning_templates").select("default_event_type").eq("tenant_id", fresh.id).eq("starter_key", "wedding").single()).data?.default_event_type).toBe("wedding");
    await page.goto(`/staff/${fresh.slug}/setup`);
    await expect(task(page, "planning")).toHaveAttribute("data-status", "ready");
    await expect(task(page, "planning")).toContainText("Default for Wedding events.");
    await page.goto(`/staff/${fresh.slug}/settings#planning-defaults`);
    const defaults = page.getByTestId("planning-defaults");
    await expect(defaults.getByRole("link", { name: "Wedding" })).toBeVisible();
    await expect(defaults).toContainText("No default: event basics only");

    // The dashboard keeps showing only the required steps still missing.
    await page.goto(`/staff/${fresh.slug}`);
    await expect(page.getByTestId("setup-checklist")).toContainText("1 of 4 required steps ready");
    await expect(page.getByTestId("setup-identity")).toHaveCount(0);
    await expect(page.getByTestId("upcoming-empty")).toBeVisible();
    await page.context().close();
  });

  test("staff see owner-only steps and settings read-only", async () => {
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${fresh.slug}/setup`);
    await expect(task(staff, "taxes")).toContainText("Owner only");
    await expect(task(staff, "taxes").getByRole("link")).toHaveText("View");
    await expect(task(staff, "packages").getByRole("link")).toHaveText("Add packages");
    await expect(staff.getByTestId("setup-readiness")).toContainText("can only be completed by the business owner");
    await task(staff, "taxes").getByRole("link").click();
    await expect(staff.getByText("Only the owner can change tax settings.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Save tax settings" })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Save settings" })).toHaveCount(0);
    await expect(staff.getByTestId("access-role")).toContainText("You are a staff member");
    await expect(staff.getByTestId("access-role")).toContainText("1 owner and 1 staff member");
    await staff.context().close();
  });

  test("an established business works normally and can reopen the guide from Settings", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, established.ownerEmail);
    await page.goto(`/staff/${established.slug}`);
    await expect(page).toHaveURL(new RegExp(`/staff/${established.slug}$`)); // never redirected into setup
    await expect(page.getByTestId("setup-checklist")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Upcoming events" })).toBeVisible();

    await page.goto(`/staff/${established.slug}/settings`);
    await expect(page.getByTestId("setup-return")).toHaveCount(0); // only when opened from the guide
    await page.getByRole("link", { name: "Setup guide" }).click();
    await page.waitForURL(`**/staff/${established.slug}/setup`);
    await expect(page.getByRole("heading", { level: 1, name: "Your business is set up" })).toBeVisible();
    await expect(page.getByTestId("ready-proposals")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("ready-contracts")).toHaveAttribute("data-ready", "true");
    await expect(task(page, "packages")).toHaveAttribute("data-status", "ready");
    await expect(task(page, "contract-template")).toHaveAttribute("data-status", "ready");

    // Another business's guide is refused like any other page of it.
    await page.goto(`/staff/${fresh.slug}/setup`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.context().close();
  });

  test("a suspended workspace's guide shows the existing unavailable page", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, suspended.ownerEmail);
    suspendLocally(suspended.id);
    await page.goto(`/staff/${suspended.slug}/setup`);
    await page.waitForURL("**/unavailable");
    await page.context().close();
  });

  test("on a 320 px phone: no sideways scrolling, compact section links and keyboard use", async ({}, info) => {
    const page = await (await browser.newContext(NARROW)).newPage();
    await signInStaff(page, fresh.ownerEmail);
    await page.goto(`/staff/${fresh.slug}/setup`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await shot(page, info, "setup-phone");
    // A step's link works from the keyboard.
    await task(page, "taxes").getByRole("link").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/settings?from=setup#taxes`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Access" }).click();
    await expect(page).toHaveURL(/#access$/);
    await expect(page.getByTestId("access-role")).toBeInViewport();
    await shot(page, info, "settings-phone");
    await page.context().close();
  });
});
