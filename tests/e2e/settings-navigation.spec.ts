/**
 * Business Settings' pages and navigation: the directory, the left column on
 * desktop, the back link on phones, old links (single-page #anchors, /team)
 * and read-only access for staff. What each form saves is covered by its own
 * flow (settings-review, branding, tax-settings, cutoff, team).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const run = randomUUID().slice(0, 6);
const PAGES = [
  ["profile", "Business profile"],
  ["branding", "Branding"],
  ["team", "Team & access"],
  ["bookings", "Bookings"],
  ["taxes", "Taxes & payments"],
  ["planning", "Client planning"],
] as const;
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.serial("settings navigation", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  let owner: Page;
  const staffEmail = `e2e-settings-nav-staff-${run}@example.test`;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("settings-nav");
    other = await createTestTenant("settings-nav-other");
    const { data: staffUser, error } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    if (error) throw error;
    const { error: memberError } = await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: staffUser.user!.id, role: "staff" });
    if (memberError) throw memberError;
    owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(owner, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await owner?.context().close();
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("the directory lists every page, in two groups, and each page has its own address", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings`);
    await expect(heading(owner, "Business settings")).toBeVisible();
    const directory = owner.getByTestId("settings-directory");
    await expect(directory.getByRole("heading")).toHaveText(["General", "Operations"]);
    await expect(directory.getByRole("link")).toHaveCount(PAGES.length);
    // The directory is the navigation here; no second list beside it.
    await expect(owner.getByRole("navigation", { name: "Settings" })).toHaveCount(1);
    await expect(owner.getByRole("textbox")).toHaveCount(0);

    for (const [path, label] of PAGES) {
      await owner.goto(`/staff/${tenant.slug}/settings/${path}`);
      await expect(heading(owner, label)).toBeVisible();
      await expect(owner.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
      await expect(owner.getByRole("navigation", { name: "Settings" }).locator('[aria-current="page"]')).toHaveText(label);
    }
  });

  test("desktop: the left column changes the page, keeps its place and never shows another page's settings", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings/profile`);
    const nav = owner.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("heading")).toHaveText(["General", "Operations"]);
    await expect(owner.getByLabel("Legal business name")).toBeVisible();
    await expect(owner.getByTestId("settings-back")).toBeHidden();

    await nav.getByRole("link", { name: "Bookings" }).click();
    await owner.waitForURL(`**/settings/bookings`);
    await expect(heading(owner, "Bookings")).toBeVisible();
    await expect(owner.getByLabel("Legal business name")).toHaveCount(0);
    await expect(owner.getByTestId("proposal-default")).toBeVisible();

    // The deposit is shown here and leads to where it is edited.
    await owner.getByTestId("deposit-summary").getByRole("link").click();
    await owner.waitForURL(`**/settings/taxes#deposit`);
    await expect(owner.getByLabel("Deposit due on signing (%)")).toBeInViewport();

    await nav.getByRole("link", { name: "Setup guide" }).click();
    await owner.waitForURL(`**/staff/${tenant.slug}/setup`);

    // Back to the directory, from the settings navigation and from the main menu.
    await owner.goto(`/staff/${tenant.slug}/settings/taxes`);
    const links = await nav.getByRole("link").allTextContents();
    expect(links[0]).toBe("All settings");
    expect(links.at(-1)).toBe("Setup guide");
    await nav.getByRole("link", { name: "All settings" }).click();
    await owner.waitForURL(`**/staff/${tenant.slug}/settings`);
    await expect(owner.getByTestId("settings-directory")).toBeVisible();
    await owner.goto(`/staff/${tenant.slug}/settings/branding`);
    await owner.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" }).click();
    await owner.waitForURL(`**/staff/${tenant.slug}/settings`);
    await expect(owner.getByTestId("settings-directory")).toBeVisible();
  });

  test("old links land on the right page, without leaving a stop in the history", async () => {
    const forwards = [
      ["#taxes", "/settings/taxes"],
      ["#branding", "/settings/branding"],
      ["#booking", "/settings/bookings"],
      ["#planning-defaults", "/settings/planning"],
      ["#access", "/settings/team"],
      ["#legal", "/settings/profile#legal"],
      ["#reply-to", "/settings/profile#reply-to"],
      ["#dj-name", "/settings/planning#dj-name"],
    ];
    for (const [hash, target] of forwards) {
      await owner.goto(`/staff/${tenant.slug}/settings${hash}`);
      await owner.waitForURL(`**/staff/${tenant.slug}${target}`);
    }
    await expect(owner.locator("#dj-name")).toBeInViewport();

    // Opened from the guide, the way back to it still shows.
    await owner.goto(`/staff/${tenant.slug}/settings?from=setup#taxes`);
    await owner.waitForURL(`**/settings/taxes?from=setup`);
    await expect(owner.getByTestId("setup-return")).toBeVisible();

    // Back skips the forwarding page rather than bouncing forward again.
    await owner.goto(`/staff/${tenant.slug}/events`);
    await owner.goto(`/staff/${tenant.slug}/settings#taxes`);
    await owner.waitForURL(`**/settings/taxes`);
    await owner.goBack();
    await owner.waitForURL(`**/staff/${tenant.slug}/events`);

    // An anchor that was never one stays on the directory.
    await owner.goto(`/staff/${tenant.slug}/settings#nothing`);
    await expect(heading(owner, "Business settings")).toBeVisible();
    await expect(owner).toHaveURL(/\/settings#nothing$/);

    // The old Team address, for the owner and keeping its anchor.
    await owner.goto(`/staff/${tenant.slug}/team`);
    await owner.waitForURL(`**/settings/team`);
    await expect(owner.getByRole("button", { name: "Send invitation" })).toBeVisible();
    await owner.goto(`/staff/${tenant.slug}/team#invite`);
    await owner.waitForURL(`**/settings/team#invite`);
  });

  test("staff read every page with nothing to save, and the old Team address works for them", async () => {
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    for (const [path, label] of PAGES) {
      await staff.goto(`/staff/${tenant.slug}/settings/${path}`);
      await expect(heading(staff, label)).toBeVisible();
      await expect(staff.getByRole("main").getByRole("button", { name: /^Save/ })).toHaveCount(0);
      await expect(staff.getByRole("main").getByText(/Only the owner can/).first()).toBeVisible();
    }
    await staff.goto(`/staff/${tenant.slug}/team`);
    await staff.waitForURL(`**/settings/team`);
    await expect(staff.getByTestId("access-role")).toContainText("You are a staff member");
    await expect(staff.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
    await staff.context().close();
  });

  test("another business's settings are refused on every page", async () => {
    for (const path of ["", ...PAGES.map(([p]) => `/${p}`)]) {
      await owner.goto(`/staff/${other.slug}/settings${path}`);
      await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
    }
    await owner.goto(`/staff/${other.slug}/team`);
    await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("every page is sections on hairlines, not cards, and read-only values don't look like fields", async () => {
    for (const [path] of PAGES) {
      await owner.goto(`/staff/${tenant.slug}/settings/${path}`);
      await expect(owner.getByRole("main").locator('[data-slot="card"]')).toHaveCount(0);
    }
    await owner.goto(`/staff/${tenant.slug}/settings/profile`);
    const workspace = owner.getByRole("region", { name: "Workspace" });
    await expect(workspace).toContainText(tenant.displayName);
    await expect(workspace).toContainText("America/Toronto");
    await expect(workspace.locator("input, textarea, select")).toHaveCount(0);
    await expect(workspace.locator("dt")).toHaveText(["Display name", "Time zone", "Currency"]);
    await expect(workspace).toContainText("can't be changed here");
    await expect(workspace).not.toContainText("each event keeps its own");
    // Field sizes follow what they hold, and a short field's hint keeps its width.
    expect((await owner.getByLabel("Legal business name").boundingBox())!.width).toBeLessThanOrEqual(450);
    await expect(owner.getByLabel("Deposit due on signing (%)")).toHaveCount(0);
    // The two addresses are told apart.
    await expect(owner.getByRole("region", { name: "Contract details" })).toContainText("Printed in contracts, for clients to reach you.");
    await expect(owner.getByRole("region", { name: "Replies and notifications" })).toContainText("isn't printed on contracts");
    // The deposit field is sized to what it holds, while its section keeps its reading width.
    await owner.goto(`/staff/${tenant.slug}/settings/taxes`);
    expect((await owner.getByLabel("Deposit due on signing (%)").boundingBox())!.width).toBeLessThanOrEqual(100);
    expect((await owner.getByRole("region", { name: "Deposit" }).boundingBox())!.width).toBeGreaterThan(300);
  });

  test("bookings explain all three workflows on demand, and new-event defaults stay separate from the policy", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings/bookings`);
    const guide = owner.getByTestId("booking-workflows");
    await expect(guide).toBeHidden();
    await owner.getByText("How booking works").click();
    await expect(guide.locator("dt")).toHaveText(["Proposal, then contract", "Contract only", "Planning only"]);
    await expect(guide).toContainText("no proposal, contract or deposit");
    await expect(owner.getByRole("region", { name: "New events" }).getByRole("checkbox", { name: "Send proposals by default" })).toBeVisible();
    const policy = owner.getByRole("region", { name: "Booking confirmation" });
    await expect(policy.getByRole("radio")).toHaveCount(2);
    await expect(policy.getByTestId("deposit-summary").getByRole("link")).toHaveAttribute("href", `/staff/${tenant.slug}/settings/taxes#deposit`);
  });

  test("taxes keep all three category states, and rows stack on a narrow phone", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings/taxes`);
    const category = owner.getByRole("group", { name: "Category standard" });
    for (const state of ["Not configured", "No tax", "Apply taxes"]) await expect(category.getByRole("radio", { name: state })).toHaveCount(1);
    await expect(category).toContainText(/Not used by active gear or packages|Used by/);

    const page = await (await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/settings/taxes`);
    await page.getByRole("button", { name: "Add tax" }).tap();
    const name = page.getByLabel("Tax 1 name");
    const rate = page.getByLabel("Tax 1 rate (%)");
    await expect(name).toBeVisible();
    expect((await rate.boundingBox())!.y).toBeGreaterThan((await name.boundingBox())!.y);
    await expect(page.getByRole("button", { name: /^Remove tax 1/ })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  test("branding: preview beside the form only with room for it, and a business with no logo shows its name", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings/branding`);
    await expect(owner.getByTestId("logo-current")).toContainText(tenant.displayName);
    const preview = owner.getByTestId("branding-preview");
    const logo = owner.getByLabel("Logo", { exact: true });
    const beside = async () => (await preview.boundingBox())!.x > (await logo.boundingBox())!.x + 100 && (await preview.boundingBox())!.y < (await logo.boundingBox())!.y + 100;
    expect(await beside()).toBe(true);
    await owner.setViewportSize({ width: 1024, height: 800 });
    expect(await beside()).toBe(false);
    expect(await sideways(owner)).toBeLessThanOrEqual(0);
    await owner.setViewportSize({ width: 1280, height: 900 });
  });

  test("a 320 px phone: directory, back link and no sideways scrolling, no sidebar", async () => {
    const page = await (await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/settings`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    for (const [path, label] of PAGES) {
      await page.goto(`/staff/${tenant.slug}/settings`);
      await page.getByTestId("settings-directory").getByRole("link", { name: new RegExp(`^${label}`) }).tap();
      await page.waitForURL(`**/settings/${path}`);
      await expect(heading(page, label)).toBeVisible();
      await expect(page.getByRole("main").getByRole("navigation", { name: "Settings" })).toBeHidden();
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    }
    await expect(page.getByTestId("settings-back")).toHaveText("All settings");
    await page.getByTestId("settings-back").tap();
    await page.waitForURL(`**/staff/${tenant.slug}/settings`);
    await expect(page.getByTestId("settings-directory")).toBeVisible();
    await page.context().close();

    const staff = await (await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })).newPage();
    await signInStaff(staff, staffEmail);
    for (const [path, label] of PAGES) {
      await staff.goto(`/staff/${tenant.slug}/settings/${path}`);
      await expect(heading(staff, label)).toBeVisible();
      expect(await sideways(staff)).toBeLessThanOrEqual(0);
    }
    await staff.context().close();
  });
});
