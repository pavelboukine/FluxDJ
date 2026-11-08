/**
 * The setup guide (/staff/{tenant}/setup) and the regrouped Business settings,
 * in dedicated test businesses: a new workspace whose steps follow what's
 * saved through the real Settings and planning template screens, a staff
 * member's read-only view, an established business that is never pushed
 * into setup, setup guidance (contracts only, planning only and back, and
 * staff's read-only view of it), another business's guide refused, a
 * suspended workspace, and a 320 px phone with keyboard use. Setup status is derived from saved data
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
  let guided: TestTenant;
  const staffEmail = `e2e-setup-staff-${run}@example.test`;
  const guidedStaffEmail = `e2e-setup-guided-staff-${run}@example.test`;

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

    // A business that books directly: legal details and taxes saved, but no packages and no contract template yet.
    guided = await createTestTenant("setup-guid");
    const { data: guidedStaff } = await admin.auth.admin.createUser({ email: guidedStaffEmail, email_confirm: true });
    await ok(admin.from("tenant_memberships").insert({ tenant_id: guided.id, user_id: guidedStaff.user!.id, role: "staff" }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(fresh);
    await archiveTestTenant(established);
    await archiveTestTenant(suspended);
    await archiveTestTenant(guided);
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
    await expect(page.getByTestId("setup-readiness")).not.toContainText("required steps ready"); // no overall counter
    await expect(page.getByTestId("ready-proposals")).toContainText("Still needs: Taxes, Three packages.");
    // A contract-only booking needs neither taxes nor packages, and planning-only events need neither step.
    await expect(page.getByTestId("ready-contracts")).toContainText("Still needs: Business details, Contract template.");
    await expect(page.getByTestId("ready-planning")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("setup-readiness")).not.toContainText("once a proposal is approved");

    // Required, recommended and optional steps, each linking to its existing page.
    const expected: [string, string, string][] = [
      ["identity", "not_started", `/staff/${fresh.slug}/settings/profile?from=setup`],
      ["branding", "optional", `/staff/${fresh.slug}/settings/branding?from=setup`],
      ["booking", "not_started", `/staff/${fresh.slug}/settings/bookings?from=setup`],
      ["taxes", "not_started", `/staff/${fresh.slug}/settings/taxes?from=setup`],
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
    // Every status has its words next to the glyph.
    await expect(task(page, "identity").getByTestId("setup-status")).toHaveText("Not started");
    await expect(task(page, "branding")).toContainText("Optional");
    await expect(task(page, "branding")).toContainText("Add your logo or choose a brand colour.");
    await expect(task(page, "proposal-template")).toContainText("Recommended");
    await expect(task(page, "packages")).toContainText("Needed to send proposals");
    await shot(page, info, "setup-new-desktop");

    // Business details through the regrouped Settings page, then back.
    await task(page, "identity").getByRole("link").click();
    await page.waitForURL(`**/staff/${fresh.slug}/settings/profile?from=setup`);
    await expect(page.getByLabel("Legal business name")).toHaveValue("");
    await page.getByLabel("Legal business name").fill("E2E Setup Sound Inc.");
    await page.getByLabel("Business address").fill("2 Setup Street, Montréal, QC");
    await page.getByLabel("Contact email").fill(`setup-${run}@example.test`);
    await page.getByRole("region", { name: "Contract details" }).getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Settings saved.", { exact: false })).toBeVisible();
    await page.getByTestId("setup-return").click();
    await page.waitForURL(`**/staff/${fresh.slug}/setup`);
    await expect(task(page, "identity")).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("ready-contracts")).toContainText("Still needs: Contract template.");
    // Saving the legal details doesn't review the booking policy, which is still the untouched default.
    await expect(task(page, "booking")).toHaveAttribute("data-status", "not_started");
    await expect(task(page, "booking").getByTestId("setup-status")).toHaveText("Recommended");
    await expect(task(page, "booking")).toContainText("Not reviewed yet.");

    await task(page, "booking").getByRole("link").click();
    await page.waitForURL(`**/settings/bookings?from=setup`);
    await expect(page.getByTestId("deposit-summary")).toContainText("50%");
    await page.getByRole("region", { name: "Booking confirmation" }).getByRole("button", { name: "Save changes" }).click();
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
    await page.getByTestId("planning-template-row").getByRole("link", { name: "Wedding", exact: true }).click();
    await page.getByLabel("Default for event type").selectOption("wedding");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect.poll(async () => (await admin.from("planning_templates").select("default_event_type").eq("tenant_id", fresh.id).eq("starter_key", "wedding").single()).data?.default_event_type).toBe("wedding");
    await page.goto(`/staff/${fresh.slug}/setup`);
    await expect(task(page, "planning")).toHaveAttribute("data-status", "ready");
    await expect(task(page, "planning")).toContainText("Default for Wedding events.");
    await page.goto(`/staff/${fresh.slug}/settings/planning`);
    const defaults = page.getByTestId("planning-defaults");
    await expect(defaults.getByRole("link", { name: "Wedding" })).toBeVisible();
    await expect(defaults).toContainText("No default: event basics only");

    // The dashboard keeps showing only the required steps still missing, by workflow.
    await page.goto(`/staff/${fresh.slug}`);
    await expect(page.getByTestId("setup-reminder-contracts")).toContainText("Contract template");
    await expect(page.getByTestId("setup-reminder-proposals")).toContainText("Taxes");
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
    await expect(task(staff, "packages").getByRole("link")).toHaveText("Create packages");
    await expect(staff.getByTestId("setup-readiness")).toContainText("can only be completed by the business owner");
    await task(staff, "taxes").getByRole("link").click();
    await expect(staff.getByText("Only the owner can change tax settings.")).toBeVisible();
    await expect(staff.getByRole("main").getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await staff.goto(`/staff/${fresh.slug}/settings/profile`);
    await expect(staff.getByRole("main").getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await staff.goto(`/staff/${fresh.slug}/settings/team`);
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
    // Ready to work, and honest about what's only recommended: nothing here reads as a problem.
    await expect(page.getByRole("heading", { level: 1, name: "You're ready to send proposals and contracts" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("The recommended steps below are worth a look, but nothing is blocking you.");
    await expect(task(page, "booking").getByTestId("setup-status")).toHaveText("Recommended");
    await expect(page.getByRole("main")).not.toContainText("Needs attention");
    await expect(page.getByTestId("ready-proposals")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("ready-contracts")).toHaveAttribute("data-ready", "true");
    await expect(task(page, "packages")).toHaveAttribute("data-status", "ready");
    await expect(task(page, "contract-template")).toHaveAttribute("data-status", "ready");

    // Another business's guide is refused like any other page of it.
    await page.goto(`/staff/${fresh.slug}/setup`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.context().close();
  });

  test("setup guidance: contracts only, planning only and back, without changing what can be sent", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(page, guided.ownerEmail);
    const tenantRow = async () => (await admin.from("tenants").select("setup_guidance, proposals_by_default").eq("id", guided.id).single()).data;
    const choose = async (label: string, saved: string) => {
      await page.getByTestId("setup-guidance").getByRole("radio", { name: new RegExp(`^${label}`) }).check();
      await page.getByRole("button", { name: "Save guidance" }).click();
      await expect(page.getByText(saved)).toBeVisible();
    };

    // By default the dashboard reminds about both workflows, with a way to choose.
    await page.goto(`/staff/${guided.slug}`);
    const card = page.getByTestId("setup-checklist");
    await expect(card.getByTestId("setup-reminder-contracts")).toContainText("Contract template");
    await expect(card.getByTestId("setup-reminder-proposals")).toContainText("0 of 3 active packages.");
    await card.getByTestId("setup-guidance-link").click();
    await page.waitForURL(`**/staff/${guided.slug}/setup#guidance`);
    await expect(page.getByTestId("setup-guidance").getByRole("radio", { name: /^Proposals and contracts/ })).toBeChecked();
    await expect(page.getByTestId("setup-guidance")).toContainText("doesn't turn off any feature or change how new events are created");

    // Contracts only: proposal steps read Skipped (never Ready), and stay one click away.
    await choose("Contracts only", "Saved. Setup reminders now cover contracts only.");
    await expect(page.getByTestId("setup-group-proposals")).toHaveAttribute("data-skipped", "true");
    await expect(page.getByTestId("setup-group-contracts")).toHaveAttribute("data-skipped", "false");
    await expect(task(page, "packages")).toBeHidden(); // collapsed
    await page.getByText("Show proposals steps").click();
    await expect(task(page, "packages")).toHaveAttribute("data-status", "skipped");
    await expect(task(page, "packages").getByTestId("setup-status")).toHaveText("Skipped");
    await expect(task(page, "packages").getByRole("link")).toHaveAttribute("href", `/staff/${guided.slug}/packages?from=setup`);
    await expect(task(page, "taxes")).toHaveAttribute("data-status", "ready"); // saved stays saved
    await expect(task(page, "contract-template")).toHaveAttribute("data-status", "not_started");
    // What can be sent is reported as it is.
    await expect(page.getByTestId("ready-proposals")).toHaveAttribute("data-ready", "false");
    await expect(page.getByTestId("ready-proposals")).toHaveAttribute("data-reminded", "false");
    await expect(page.getByTestId("ready-proposals")).toContainText("Skipped");
    await expect(page.getByTestId("ready-proposals")).toContainText("Can't be sent yet. Still needs: Three packages.");
    expect(await tenantRow()).toEqual({ setup_guidance: "contracts_only", proposals_by_default: true }); // event defaults untouched
    await shot(page, info, "setup-guidance-contracts-only");

    await page.goto(`/staff/${guided.slug}`);
    await expect(card).toContainText("Still needed before you can send contracts:");
    await expect(card.getByTestId("setup-reminder-proposals")).toHaveCount(0);
    await expect(card.getByTestId("setup-packages")).toHaveCount(0);
    await expect(card.getByTestId("setup-contract-template")).toBeVisible();
    await shot(page, info, "dashboard-contracts-only");

    // Planning only: no reminder at all; the guide still shows everything honestly.
    await page.goto(`/staff/${guided.slug}/setup`);
    await choose("Planning only", "Saved. Your dashboard won't show setup reminders.");
    await expect(page.getByRole("heading", { level: 1, name: "Your setup guide" })).toBeVisible();
    await expect(page.getByTestId("setup-group-contracts")).toHaveAttribute("data-skipped", "true");
    await expect(task(page, "identity")).toHaveAttribute("data-status", "ready"); // Business: saved, so Ready
    await expect(task(page, "planning")).toHaveAttribute("data-status", "not_started");
    await expect(page.getByTestId("ready-contracts")).toContainText("Still needs: Contract template.");
    await page.goto(`/staff/${guided.slug}`);
    await expect(page.getByTestId("setup-checklist")).toHaveCount(0);

    // Back to proposals and contracts: both reminders return, as the steps are still missing.
    await page.goto(`/staff/${guided.slug}/setup`);
    await choose("Proposals and contracts", "Saved. Setup reminders now cover proposals and contracts.");
    await expect(page.getByTestId("setup-group-proposals")).toHaveAttribute("data-skipped", "false");
    await expect(task(page, "packages")).toHaveAttribute("data-status", "not_started");
    await page.goto(`/staff/${guided.slug}`);
    await expect(card.getByTestId("setup-reminder-contracts")).toBeVisible();
    await expect(card.getByTestId("setup-reminder-proposals")).toBeVisible();
    const audits = await admin.from("audit_events").select("metadata").eq("entity_id", guided.id).eq("action", "setup_guidance_changed");
    expect(audits.data).toHaveLength(3);
    await page.context().close();
  });

  test("staff see the setup guidance read-only, on a phone", async ({}, info) => {
    await ok(admin.from("tenants").update({ setup_guidance: "contracts_only" }).eq("id", guided.id));
    const staff = await (await browser.newContext(NARROW)).newPage();
    await signInStaff(staff, guidedStaffEmail);
    await staff.goto(`/staff/${guided.slug}/setup`);
    const guidance = staff.getByTestId("setup-guidance");
    await expect(guidance.getByTestId("setup-guidance-current")).toContainText("Contracts only");
    await expect(guidance).toContainText("Only the owner can change this.");
    await expect(guidance.getByRole("radio")).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Save guidance" })).toHaveCount(0);
    await expect(staff.getByTestId("setup-group-proposals")).toContainText("Only the owner can change this.");
    expect(await sideways(staff)).toBeLessThanOrEqual(0);
    await shot(staff, info, "setup-guidance-staff-phone");
    await staff.goto(`/staff/${guided.slug}`);
    await expect(staff.getByTestId("setup-reminder-contracts")).toBeVisible();
    await expect(staff.getByTestId("setup-reminder-proposals")).toHaveCount(0);
    await expect(staff.getByTestId("setup-guidance-link")).toHaveCount(0);
    expect(await sideways(staff)).toBeLessThanOrEqual(0);
    await staff.context().close();
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
    await page.waitForURL(`**/settings/taxes?from=setup`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // Between settings pages on a phone: back to the directory, then on to another page.
    await page.getByTestId("settings-back").click();
    await page.getByTestId("settings-directory").getByRole("link", { name: /^Team & access/ }).click();
    await page.waitForURL(`**/settings/team`);
    await expect(page.getByTestId("access-role")).toBeInViewport();
    await shot(page, info, "settings-phone");
    await page.context().close();
  });
});
