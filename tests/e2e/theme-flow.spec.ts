/**
 * Light / Dark / System in real browsers, in dedicated test businesses. Staff: System by default and
 * following the device live, a choice kept in this browser and applied before anything is shown, no
 * hydration or console errors, only the marketing home page light, the workspace header's logo for its
 * background, previews that match client pages, and the choice on a phone. Clients: the header's
 * Theme menu, brand colours and logos for the page's theme, anonymous proposal and contract links
 * following the device, the contract and signature pad on light paper, and printing always light.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { brandTheme } from "@/lib/branding/colors";
import { bookEvent, must, openPlanning, sendContractFor, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { paddedDiscPng, whiteOnTransparentPng } from "../support/logo-fixtures";

const files: Record<string, string> = {};
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const colorScheme = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("flux-theme"));
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Every console error or React warning on the page (hydration mismatches, misplaced scripts). */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /hydrat|script tag|did not match/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
}
/** Records, before any page script runs, whether `dark` was on <html> when the page's main content was first parsed. */
const recordFirstPaintTheme = (context: BrowserContext) =>
  context.addInitScript(() => {
    const w = window as unknown as { __themeAtContent?: boolean };
    const check = () => {
      if (w.__themeAtContent === undefined && document.querySelector("[data-app-main]")) {
        w.__themeAtContent = document.documentElement.classList.contains("dark");
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
const themeAtContent = (page: Page) => page.evaluate(() => (window as unknown as { __themeAtContent?: boolean }).__themeAtContent);

/** Average sRGB channel (0 to 255) of an element's background (or text) colour, whatever colour syntax the browser reports. */
const lightnessOf = (el: Element, property: "backgroundColor" | "color" = "backgroundColor") => {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = getComputedStyle(el)[property];
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return (r + g + b) / 3;
};

async function chooseTheme(page: Page, label: "Light" | "Dark" | "System") {
  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitemradio", { name: label }).click();
  // The menu stays open, showing the choice.
  await expect(page.getByRole("menuitemradio", { name: label })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
}

test.describe.serial("staff theme", () => {
  let browser: Browser;
  let t: TestTenant;

  test.beforeAll(async ({ browser: br }, info) => {
    browser = br;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    writeFileSync((files["black-disc.png"] = join(dir, "black-disc.png")), await paddedDiscPng(400, 40, [17, 17, 17]));
    t = await createTestTenant("theme");
  });

  test.afterAll(async () => {
    await archiveTestTenant(t);
  });

  test("System by default: follows the device, live, with no hydration or console errors", async () => {
    const context = await browser.newContext({ colorScheme: "dark" });
    await recordFirstPaintTheme(context);
    const page = await context.newPage();
    const problems = watchConsole(page);
    await signInStaff(page, t.ownerEmail);
    await page.goto(`/staff/${t.slug}`);
    expect(await isDark(page)).toBe(true);
    expect(await themeAtContent(page)).toBe(true); // dark before the page's content was parsed: no flash
    expect(await colorScheme(page)).toBe("dark"); // native controls and scrollbars follow
    await expect(page.locator("body")).toHaveCSS("background-color", /^(oklch|lab|rgb)/);

    // The device switches to light: the page follows without a reload.
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(page)).toBe(true);

    await page.getByTestId("account-menu").click();
    const choices = page.getByRole("menuitemradio");
    await expect(choices).toHaveText(["Light", "Dark", "System"]);
    await expect(page.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    // Navigating within the staff area: no errors, no mismatch.
    await page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Events" }).click();
    await page.waitForURL("**/events");
    expect(await isDark(page)).toBe(true);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("a chosen theme is kept in this browser, applied before content appears, and beats the device setting", async () => {
    const context = await browser.newContext({ colorScheme: "light" });
    await recordFirstPaintTheme(context);
    const page = await context.newPage();
    const problems = watchConsole(page);
    await signInStaff(page, t.ownerEmail);
    await page.goto(`/staff/${t.slug}/events`);
    expect(await isDark(page)).toBe(false);

    await chooseTheme(page, "Dark");
    expect(await isDark(page)).toBe(true);
    expect(await stored(page)).toBe("dark");

    await page.reload();
    expect(await themeAtContent(page)).toBe(true);
    const other = await context.newPage();
    await other.goto(`/staff/${t.slug}/clients`);
    expect(await isDark(other)).toBe(true);
    await other.close();

    // Light wins over a dark device, and System hands it back.
    await page.emulateMedia({ colorScheme: "dark" });
    await chooseTheme(page, "Light");
    expect(await isDark(page)).toBe(false);
    await page.reload();
    expect(await themeAtContent(page)).toBe(false);
    await chooseTheme(page, "System");
    expect(await isDark(page)).toBe(true);
    expect(await stored(page)).toBe("system");
    expect(problems).toEqual([]);
    await context.close();
  });

  test("only the marketing home page stays light; moving between it, sign-in and staff pages never shows the wrong theme", async () => {
    const context = await browser.newContext({ colorScheme: "light" });
    await context.addInitScript(() => localStorage.setItem("flux-theme", "dark"));
    const page = await context.newPage();
    const problems = watchConsole(page);
    await page.goto("/");
    expect(await isDark(page)).toBe(false);
    expect(await colorScheme(page)).toBe("light");
    // Within the app, from the light home page to sign-in: the saved choice applies at once.
    await page.getByRole("link", { name: /sign in/i }).first().click();
    await page.waitForURL("**/login**");
    await expect.poll(() => isDark(page)).toBe(true);
    for (const path of ["/login", `/${t.slug}/p`]) {
      await page.goto(path);
      expect(await isDark(page), path).toBe(true);
      expect(await colorScheme(page), path).toBe("dark");
    }
    await signInStaff(page, t.ownerEmail);
    expect(await isDark(page)).toBe(true);
    await page.getByTestId("account-menu").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login**");
    expect(await isDark(page)).toBe(true);
    // And back to the home page: light again, the choice kept for the next visit.
    await page.goto("/");
    expect(await isDark(page)).toBe(false);
    expect(await stored(page)).toBe("dark");
    expect(problems).toEqual([]);
    await context.close();
  });

  test("the workspace header shows the logo for its background; previews follow the theme like client pages", async () => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await signInStaff(page, t.ownerEmail);
    await page.goto(`/staff/${t.slug}/settings/branding`);
    await page.getByLabel("Logo", { exact: true }).setInputFiles(files["black-disc.png"]);
    await expect(page.getByTestId("logo-preview-state")).toHaveText("The preview shows the logo as it will be saved.");
    await page.getByTestId("logo-on-dark").locator("summary").click();
    await page.getByLabel("Create a white version of my logo").check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();

    const header = page.getByTestId("workspace-brand");
    const shown = header.getByRole("img", { name: t.displayName });
    // Light: the logo itself; the white version is in the page but not shown.
    await expect(shown).toHaveCount(1);
    await expect(header.locator('[data-logo-theme="light"] [data-logo="main"] img')).toBeVisible();
    await expect(header.locator('[data-logo-theme="dark"] img')).toBeHidden();

    await chooseTheme(page, "Dark");
    await expect(shown).toHaveCount(1);
    await expect(header.locator('[data-logo-theme="dark"] [data-logo="on-dark"] img')).toBeVisible();
    await expect(header.locator('[data-logo-theme="light"] img')).toBeHidden();
    await expect(header.locator('[data-logo-theme="dark"] [data-logo="on-dark"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // The Flux wordmark turns white with it.
    await expect(page.locator('header img[src="/brand/flux-wordmark-white.png"]').first()).toBeVisible();
    await expect(page.locator('header img[src="/brand/flux-wordmark-black.png"]').first()).toBeHidden();

    // The preview is what clients see in this theme: dark, like their dark pages, with readable text.
    const lightness = (selector: string) => page.locator(selector).first().evaluate(lightnessOf);
    expect(await lightness('[data-testid="proposal-preview"]')).toBeLessThan(60);
    expect(await page.getByTestId("proposal-preview").getByText("Signature package").evaluate(lightnessOf, "color" as const)).toBeGreaterThan(200);
    expect(await lightness("[data-app-main] > div")).toBeLessThan(60);
    await context.close();
  });

  test("on a phone: the choice is in the account menu, the drawer is dark, nothing scrolls sideways", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const page = await context.newPage();
    await signInStaff(page, t.ownerEmail);
    await page.goto(`/staff/${t.slug}`);
    await chooseTheme(page, "Dark");
    expect(await isDark(page)).toBe(true);
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    const drawerLightness = await drawer.evaluate(lightnessOf);
    expect(drawerLightness).toBeLessThan(60);
    await context.close();
  });
});

/** A registered logo for `t` (as an upload leaves it). */
async function registerLogo(t: TestTenant, png: Buffer, size: [number, number], light: boolean): Promise<{ id: string; path: string }> {
  const path = `${t.id}/logos/${randomUUID()}.png`;
  await must(admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" }));
  const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", t.id).eq("role", "owner").single());
  const { data: id } = await must(admin.rpc("register_tenant_logo", {
    p_tenant_id: t.id, p_user_id: owner!.user_id, p_storage_path: path, p_sha256: createHash("sha256").update(png).digest("hex"),
    p_byte_size: png.length, p_width: size[0], p_height: size[1], p_needs_dark_background: light,
  }));
  return { id: id as string, path };
}
const cssVar = (page: Page, selector: string, name: string) => page.locator(selector).first().evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);

test.describe.serial("client theme", () => {
  const RED = { primary: "#e11d48", accent: "#d97706", gradient: "on" };
  let browser: Browser;
  let t: TestTenant;
  let clientEmail = "";
  const ids = { booked: "", pending: "", pendingLink: "", inviteToken: "", proposalToken: "", darkLogo: "", mainLogo: "" };

  test.beforeAll(async ({ browser: br }) => {
    test.setTimeout(240_000);
    browser = br;
    t = await createTestTenant("theme-client", { catalog: true });
    const staff = await sessionFor(t.ownerEmail);
    await must(staff.rpc("install_starter_planning_templates", { p_tenant_id: t.id }));
    const main = await registerLogo(t, await paddedDiscPng(400, 40, [17, 17, 17]), [320, 320], false);
    const dark = await registerLogo(t, await whiteOnTransparentPng(400, 120), [320, 72], true);
    [ids.mainLogo, ids.darkLogo] = [main.path, dark.path];
    await must(staff.rpc("update_tenant_branding", { p_tenant_id: t.id, p_expected_version: 0, p_logo_id: main.id, p_primary_color: RED.primary, p_accent_color: RED.accent, p_gradient: true, p_logo_on_dark_id: dark.id, p_change_logo_on_dark: true }));
    clientEmail = `e2e-theme-client-${randomUUID().slice(0, 8)}@example.test`;
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: t.id, name: "Jordan Lee", email: clientEmail }));
    const event = async (title: string) => {
      const id = randomUUID();
      await must(admin.from("events").insert({ id, tenant_id: t.id, title, event_type: "wedding", event_date: "2027-09-18", venue_name: "Salle Lumière" }));
      await must(admin.from("event_clients").insert({ tenant_id: t.id, event_id: id, client_id: clientId, is_primary: true, can_sign: true }));
      const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", t.id).eq("starter_key", "simple_party").single());
      await must(staff.rpc("setup_event_plan", { p_event_id: id, p_template_id: template!.id }));
      return id;
    };
    ids.booked = await event("Theme Booked");
    await bookEvent(t, ids.booked, clientEmail);
    await openPlanning(t, ids.booked);
    const pendingEvent = await event("Theme Pending");
    const sent = await sendContractFor(t, pendingEvent);
    [ids.pending, ids.pendingLink, ids.inviteToken] = [sent.contractId, sent.linkId, sent.token];
    const proposalEvent = await event("Theme Proposal");
    const { data: tpl } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", t.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: tpl!.id }));
    const { data: pid } = await must(staff.rpc("open_proposal_draft", { p_event_id: proposalEvent, p_offer: input }));
    const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", pid).single());
    ids.proposalToken = randomBytes(32).toString("base64url");
    await must(staff.rpc("send_proposal", { p_proposal_id: pid, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: createHash("sha256").update(ids.proposalToken).digest("hex") }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(t);
  });

  test("anonymous proposal and invitation links follow the device; brand colours resolve for the page's theme", async () => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    const problems = watchConsole(page);
    await page.goto(`/${t.slug}/invite#${ids.inviteToken}`);
    expect(await isDark(page)).toBe(true);
    // The invitation card's logo row sits on the dark Brand Wash: the logo for dark backgrounds.
    const card = page.getByTestId("public-card-brand");
    await expect(card.locator('[data-logo-theme="dark"] [data-logo="on-dark"] img')).toBeVisible();

    await page.goto(`/${t.slug}/p#${ids.proposalToken}`);
    await page.waitForURL("**/proposals/**");
    expect(await isDark(page)).toBe(true);
    // Ink, Tint and Wash for a dark page; the gradient hero and button fill are the same in both themes.
    const [light, dark] = [brandTheme(RED), brandTheme(RED, "dark")];
    expect(await cssVar(page, "[data-brand]", "--brand-ink")).toBe(dark.ink);
    expect(await cssVar(page, "[data-brand]", "--brand-tint")).toBe(dark.tint);
    expect(await cssVar(page, "[data-brand]", "--brand-hero")).toContain(light.gradient!.from);
    expect(await cssVar(page, "[data-brand]", "--brand-fill")).toBe(light.fill);
    await expect(page.getByTestId("proposal-hero").first()).toHaveCSS("color", "rgb(255, 255, 255)");
    // The hero is the Brand Gradient in both themes: the logo for dark backgrounds, no panel.
    const heroLogo = page.getByTestId("proposal-hero").getByRole("img", { name: t.displayName });
    expect(await heroLogo.getAttribute("src")).toContain(ids.darkLogo);

    // The same link with Light chosen in this browser: light, and the light Ink.
    await page.evaluate(() => localStorage.setItem("flux-theme", "light"));
    await page.reload();
    expect(await isDark(page)).toBe(false);
    expect(await cssVar(page, "[data-brand]", "--brand-ink")).toBe(light.ink);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("signed-in clients choose a theme in the header; hub, planning and logos follow", async () => {
    const context = await browser.newContext({ colorScheme: "light", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const problems = watchConsole(page);
    await signInWithLink(page, clientEmail, "/my");
    await page.goto(`/${t.slug}/events/${ids.booked}`);
    expect(await isDark(page)).toBe(false);
    await page.getByTestId("theme-menu").click();
    await expect(page.getByRole("menuitemradio")).toHaveText(["Light", "Dark", "System"]);
    await expect(page.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    expect(await isDark(page)).toBe(true);
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);

    // The business logo above the event sits on the dark page: its version for dark backgrounds.
    await expect(page.locator('[data-logo-theme="dark"] [data-logo="on-dark"] img').first()).toBeVisible();
    // The primary button keeps white text on the brand fill in dark mode.
    const open = page.getByRole("link", { name: /open planning/i }).first();
    await expect(open).toHaveCSS("color", "rgb(255, 255, 255)");
    expect(await open.evaluate(lightnessOf)).toBeLessThan(160);

    await page.goto(`/${t.slug}/planning/${ids.booked}`);
    expect(await isDark(page)).toBe(true);
    await page.goto("/my");
    expect(await isDark(page)).toBe(true);
    await expect(page.getByTestId("footer-flux-logo-dark")).toBeVisible();
    expect(problems).toEqual([]);
    await context.close();
  });

  test("the contract and signature pad stay light paper in dark mode, and printing is always light", async () => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await must((await sessionFor(clientEmail)).rpc("accept_contract_invitation", { p_link_id: ids.pendingLink, p_tenant_slug: t.slug }));
    await signInWithLink(page, clientEmail, `/${t.slug}/contracts/${ids.pending}`);
    await page.goto(`/${t.slug}/contracts/${ids.pending}`);
    expect(await isDark(page)).toBe(true);
    const paper = page.getByTestId("agreement-paper");
    expect(await paper.evaluate(lightnessOf)).toBeGreaterThan(240);
    expect(await paper.getByRole("heading", { name: "Payment" }).evaluate(lightnessOf, "color" as const)).toBeLessThan(40); // the agreement's own text: dark on paper
    const pad = page.getByTestId("signature-canvas").locator("xpath=..");
    expect(await pad.evaluate(lightnessOf)).toBeGreaterThan(240);
    // The page around it is dark; the button to signing keeps white text on the brand fill.
    expect(await page.locator("body").evaluate(lightnessOf)).toBeLessThan(60);
    await expect(page.getByRole("link", { name: "Go to signing" })).toHaveCSS("color", "rgb(255, 255, 255)");

    await page.emulateMedia({ media: "print" });
    expect(await page.locator("body").evaluate(lightnessOf)).toBeGreaterThan(240);
    expect(await page.getByRole("heading", { level: 1 }).first().evaluate(lightnessOf, "color" as const)).toBeLessThan(60);
    expect(await colorScheme(page)).toBe("light");
    await context.close();
  });
});
