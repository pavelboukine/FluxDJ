/**
 * The shared staff and platform shell in real browsers, in dedicated test
 * businesses with generated logos (never a real business's): sidebar groups
 * and permissions, active items on detail pages, the centred business logo
 * (wide, light, none) across a workspace switch, the account menu, the phone
 * drawer's keyboard behaviour, narrow and installed-app layouts, and the
 * platform pages. E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, type TestTenant } from "./tenant";
import { transparentPng, whiteOnTransparentPng } from "../support/logo-fixtures";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

const run = randomUUID().slice(0, 6);
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// The home-screen app: iOS reports navigator.standalone (as in pwa-flow.spec.ts).
const STANDALONE = () => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });

const GROUPS = [
  ["Main", ["Dashboard", "Events", "Clients"]],
  ["Catalog", ["Gear", "Packages"]],
  ["Templates", ["Proposal templates", "Contract templates", "Planning templates", "Questions & rules"]],
  ["Business", ["Emails", "Settings"]],
] as const;
const PATHS: Record<string, string> = {
  Dashboard: "",
  Events: "/events",
  Clients: "/clients",
  Gear: "/gear",
  Packages: "/packages",
  "Proposal templates": "/templates",
  "Contract templates": "/contract-templates",
  "Planning templates": "/planning-templates",
  "Questions & rules": "/questions",
  Emails: "/emails",
  Settings: "/settings",
};

/** Stores a generated logo exactly as the server does after its checks (service role), and makes it active. */
async function setLogo(tenant: TestTenant, png: Buffer, size: { width: number; height: number }, needsDarkBackground: boolean) {
  const { data: owner } = await admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").limit(1).single();
  const path = `${tenant.id}/logos/${randomUUID()}.png`;
  const upload = await admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" });
  if (upload.error) throw upload.error;
  const { error } = await admin.rpc("register_tenant_logo", {
    p_tenant_id: tenant.id,
    p_user_id: owner!.user_id,
    p_storage_path: path,
    p_sha256: createHash("sha256").update(png).digest("hex"),
    p_byte_size: png.length,
    p_width: size.width,
    p_height: size.height,
    p_needs_dark_background: needsDarkBackground,
  });
  if (error) throw error;
  const update = await admin.from("tenants").update({ logo_storage_path: path }).eq("id", tenant.id);
  if (update.error) throw update.error;
}

/** Adds a membership: the owner of another test business, or a new throwaway user. */
async function addMember(tenant: TestTenant, role: "owner" | "staff", who: { ownerOf: TestTenant } | { email: string }) {
  let userId: string;
  if ("ownerOf" in who) {
    const { data } = await admin.from("tenant_memberships").select("user_id").eq("tenant_id", who.ownerOf.id).eq("role", "owner").limit(1).single();
    userId = data!.user_id;
  } else {
    userId = (await admin.auth.admin.createUser({ email: who.email, email_confirm: true })).data.user!.id;
  }
  const { error } = await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: userId, role });
  if (error) throw error;
}

/** Signs in straight to a business (the owner of `wide` has two, so a plain sign-in stops at the chooser). */
async function signInTo(page: Page, email: string, tenant: TestTenant) {
  await signInWithLink(page, email, `/staff/${tenant.slug}`);
  await page.waitForURL(`**/staff/${tenant.slug}`);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page: Page, name = "Staff") => page.getByRole("navigation", { name });
const brand = (page: Page) => page.getByTestId("workspace-brand");

/** The business logo (or name) is centred on the viewport, not on the space between the side controls. */
async function expectCentred(page: Page) {
  const box = (await brand(page).locator("img, span").first().boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1.5);
}

/** Wordmark, centre and account button never overlap, and nothing leaves the screen sideways. */
async function expectTopBarFits(page: Page) {
  const boxes = await Promise.all([
    page.getByRole("link", { name: "Flux DJ home" }).boundingBox(),
    brand(page).boundingBox(),
    page.getByRole("button", { name: "Account" }).boundingBox(),
  ]);
  const [left, centre, right] = boxes.map((b) => b!);
  expect(left.x + left.width).toBeLessThanOrEqual(centre.x);
  expect(centre.x + centre.width).toBeLessThanOrEqual(right.x);
  expect(right.x + right.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
}

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))); // drawer and menu transitions
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}

test.describe.serial("staff navigation shell", () => {
  let browser: Browser;
  let wide: TestTenant; // wide logo; the owner also belongs to `light`
  let light: TestTenant; // mostly white logo
  let plain: TestTenant; // no logo; its owner is a platform administrator
  let eventId = "";
  let templateId = "";
  const staffEmail = `e2e-shell-staff-${run}@example.test`;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    wide = await createTestTenant("shell-wide", { catalog: true });
    light = await createTestTenant("shell-light");
    plain = await createTestTenant("shell-plain");
    await setLogo(wide, await transparentPng(1024, 256), { width: 1024, height: 256 }, false);
    await setLogo(light, await whiteOnTransparentPng(800, 200), { width: 800, height: 200 }, true);
    await addMember(light, "staff", { ownerOf: wide });
    await addMember(wide, "staff", { email: staffEmail });
    grantPlatformAdminLocally(plain.ownerEmail);
    eventId = randomUUID();
    await admin.from("events").insert({ id: eventId, tenant_id: wide.id, title: `E2E Shell Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18" });
    const versionId = await publishContractTemplate(wide, `Shell contract ${run}`, "Wedding DJ agreement", [
      { heading: "Services", body: "The DJ performs at the event." },
      { heading: "Payment", body: "The balance is due before the event." },
    ]);
    templateId = (await admin.from("contract_template_versions").select("template_id").eq("id", versionId).single()).data!.template_id;
  });

  test.afterAll(async () => {
    revokePlatformAdminLocally(plain.ownerEmail);
    await archiveTestTenant(wide);
    await archiveTestTenant(light);
    await archiveTestTenant(plain);
  });

  test("desktop: grouped sidebar reaches every page, with the right item active on detail pages", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInTo(page, wide.ownerEmail, wide);
    await page.goto(`/staff/${wide.slug}`);
    await expect(page.getByText("Flux DJ staff")).toHaveCount(0);
    await expect(page.getByText(wide.ownerEmail)).toBeHidden(); // in the account menu now
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden(); // the sidebar replaces the drawer
    for (const [label, items] of GROUPS) {
      const group = nav(page).locator("div").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
      await expect(group.getByRole("link")).toHaveText([...items]);
    }
    await expect(nav(page).getByRole("heading", { name: "Admin" })).toHaveCount(0); // ownership alone doesn't show it
    await expect(nav(page).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expectCentred(page);
    await shot(page, info, "desktop-dashboard");

    for (const [label, path] of Object.entries(PATHS)) {
      await nav(page).getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/staff/${wide.slug}${path}$`));
      await expect(nav(page).locator('[aria-current="page"]')).toHaveText(label);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }

    // Detail pages: their own item, never a neighbour that shares a word.
    await page.goto(`/staff/${wide.slug}/events/${eventId}`);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Events");
    await shot(page, info, "desktop-event", true);
    await page.goto(`/staff/${wide.slug}/contract-templates/${templateId}`);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Contract templates");
    await shot(page, info, "desktop-long-editor", true);
    await page.goto(`/staff/${wide.slug}/events/new`);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Events");
    await page.goto(`/staff/${wide.slug}/settings`);
    await shot(page, info, "desktop-settings", true);
    await page.context().close();
  });

  test("desktop: the account menu holds the identity, switches business (logo follows) and signs out", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInTo(page, wide.ownerEmail, wide);
    await page.goto(`/staff/${wide.slug}`);
    const wideLogo = brand(page).getByRole("img", { name: wide.displayName });
    await expect(wideLogo).toBeVisible();
    const box = (await wideLogo.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(4, 0); // never stretched

    await page.getByRole("button", { name: "Account" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByTestId("account-identity")).toContainText(wide.ownerEmail);
    await expect(menu.getByTestId("account-identity")).toContainText(`Owner · ${wide.displayName}`);
    await expect(menu.getByRole("menuitem", { name: new RegExp(wide.displayName) })).toHaveAttribute("aria-current", "page");
    await shot(page, info, "desktop-account-menu");
    await menu.getByRole("menuitem", { name: new RegExp(light.displayName) }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${light.slug}$`));
    const lightLogo = brand(page).getByRole("img", { name: light.displayName });
    await expect(lightLogo).toBeVisible();
    await expect(lightLogo.locator("xpath=..")).toHaveClass(/bg-neutral-900/); // light artwork on a dark backdrop
    await expect(brand(page).getByRole("img", { name: wide.displayName })).toHaveCount(0);
    await expectCentred(page);
    // Staff role here: the Settings page is still listed; the page itself decides what staff may change.
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("menu").getByTestId("account-identity")).toContainText(`Staff · ${light.displayName}`);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login**");
    await page.goto(`/staff/${wide.slug}`);
    await page.waitForURL("**/login**"); // signed out: back to sign-in
    await page.context().close();
  });

  test("staff and platform administrators see only what their access allows", async ({}, info) => {
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    await expect(nav(staff).getByRole("heading", { name: "Admin" })).toHaveCount(0);
    await staff.getByRole("button", { name: "Account" }).click();
    await expect(staff.getByRole("menu").getByTestId("account-identity")).toContainText(`Staff · ${wide.displayName}`);
    await expect(staff.getByRole("menu").getByText("Switch business")).toHaveCount(0); // one business
    await staff.context().close();

    const operator = await (await browser.newContext()).newPage();
    await signInStaff(operator, plain.ownerEmail);
    // No logo: the business name, centred.
    await expect(brand(operator)).toHaveText(plain.displayName);
    await expect(brand(operator).getByRole("img")).toHaveCount(0);
    await expectCentred(operator);
    const adminGroup = nav(operator).locator("div").filter({ has: operator.getByRole("heading", { name: "Admin", exact: true }) });
    await expect(adminGroup.getByRole("link")).toHaveText(["DJ invitations", "Workspaces"]);
    await adminGroup.getByRole("link", { name: "Workspaces" }).click();
    await expect(operator).toHaveURL(/\/platform\/workspaces$/);
    // Platform pages: no business logo, the platform navigation, and a way back.
    await expect(brand(operator)).toHaveCount(0);
    await expect(operator.getByText("Platform administration")).toBeVisible();
    await expect(nav(operator, "Platform").locator('[aria-current="page"]')).toHaveText("Workspaces");
    await shot(operator, info, "desktop-platform");
    await nav(operator, "Platform").getByRole("link", { name: "DJ invitations" }).click();
    await expect(operator).toHaveURL(/\/platform\/invitations$/);
    await nav(operator, "Platform").getByRole("link", { name: "Your businesses" }).click();
    await expect(operator).toHaveURL(new RegExp(`/staff/${plain.slug}$`)); // one business: straight to it
    await operator.context().close();
  });

  test("phone: drawer navigation with a trapped focus, Escape, scroll lock and close after navigating", async ({}, info) => {
    const page = await (await browser.newContext(PHONE)).newPage();
    await signInTo(page, wide.ownerEmail, wide);
    await page.goto(`/staff/${wide.slug}/events/${eventId}`);
    await expect(nav(page)).toBeHidden(); // no sidebar on a phone
    await expectTopBarFits(page);
    await expectCentred(page);
    const logo = brand(page).getByRole("img", { name: wide.displayName });
    expect((await logo.boundingBox())!.height).toBeLessThanOrEqual(32.5);
    await shot(page, info, "phone-event");

    const trigger = page.getByRole("button", { name: "Open menu" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Events");
    await shot(page, info, "phone-drawer");
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      // At the end of the list a focus guard hands focus back to the start (one tick later).
      await expect.poll(() => drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    // The page behind doesn't scroll while the drawer is open (and does once it closes).
    await page.mouse.move(380, 700);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));

    await trigger.click();
    await expect(drawer.getByRole("button", { name: "Close menu" })).toBeVisible();
    await nav(page).getByRole("link", { name: "Gear" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${wide.slug}/gear$`));
    await expect(drawer).toHaveCount(0);
    await trigger.click();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(drawer).toHaveCount(0);

    // Account menu: reachable and within the screen.
    await page.getByRole("button", { name: "Account" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByTestId("account-identity")).toContainText(wide.ownerEmail);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, info, "phone-account-menu");
    await page.keyboard.press("Escape");

    await page.goto(`/staff/${wide.slug}`);
    await shot(page, info, "phone-dashboard", true);
    await page.goto(`/staff/${wide.slug}/settings`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await shot(page, info, "phone-settings");
    await page.context().close();
  });

  test("narrow, landscape and installed-app layouts keep every control reachable", async ({}, info) => {
    for (const viewport of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
      const page = await (await browser.newContext({ ...PHONE, viewport })).newPage();
      await signInTo(page, wide.ownerEmail, wide);
      await page.goto(`/staff/${wide.slug}/contract-templates/${templateId}`);
      await expectTopBarFits(page);
      await expectCentred(page);
      await page.getByRole("button", { name: "Open menu" }).click();
      const drawer = page.getByRole("dialog", { name: "Menu" });
      // Long menus scroll inside the drawer; its last item is reachable.
      await nav(page).getByRole("link", { name: "Settings" }).scrollIntoViewIfNeeded();
      await expect(nav(page).getByRole("link", { name: "Settings" })).toBeInViewport();
      expect((await drawer.boundingBox())!.width).toBeLessThan(viewport.width);
      await shot(page, info, `drawer-${viewport.width}x${viewport.height}`);
      await page.context().close();
    }

    const app = await browser.newContext({ ...PHONE, userAgent: IPHONE_SAFARI });
    await app.addInitScript(STANDALONE);
    const page = await app.newPage();
    await signInStaff(page, light.ownerEmail);
    await page.goto(`/staff/${light.slug}`);
    await expect(page.getByTestId("install-help")).toHaveCount(0); // never inside the installed app
    await expectTopBarFits(page);
    await expect(brand(page).getByRole("img", { name: light.displayName }).locator("xpath=..")).toHaveClass(/bg-neutral-900/);
    await shot(page, info, "installed-dashboard");
    await app.close();
  });
});
