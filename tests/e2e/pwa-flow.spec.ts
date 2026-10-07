/**
 * The installable app shell in a real browser against local Supabase, in
 * dedicated test tenants. Browser emulation only: it checks what the app
 * serves and how pages behave with a standalone display mode and phone user
 * agents. It does not prove real iOS installation, Safari/app cookie
 * separation or email hand-off; those are manual checks on a real iPhone.
 *   - manifest and icons: fields, sizes, types, no personal or tenant data;
 *   - /start: signed out, staff, client, both roles, several businesses;
 *   - install help: native prompt, iPhone Safari, other iOS browsers, no
 *     wrong-platform instructions, dismissal, hidden when standalone;
 *   - standalone PDF download through the share sheet with the app's
 *     session, an honest error offline, the offline notice;
 *   - phone layouts, links out of every page, no service worker or caches.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, must, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
let otherTenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-pwa-${run}@example.test`;
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** Pretends the page runs from the home screen (display-mode standalone and iOS's navigator.standalone). */
const STANDALONE = () => {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => (q.includes("display-mode: standalone") ? ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList) : original(q));
  Object.defineProperty(navigator, "standalone", { value: true });
};
function pngSize(bytes: Buffer) {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe.serial("installable app shell", () => {
  let eventId = "";

  test.beforeAll(async () => {
    tenant = await createTestTenant("pwa", { catalog: true });
    otherTenant = await createTestTenant("pwa-other");
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Chloé Gagnon", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E PWA Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14", venue_name: "Château E2E" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    await bookEvent(tenant, eventId, clientEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(otherTenant);
  });

  test("manifest and icons: one shared identity, standard sizes, nothing personal", async ({ request, page }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/manifest+json");
    const text = await res.text();
    const m = JSON.parse(text);
    expect(m).toMatchObject({ id: "/start", name: "Flux DJ", short_name: "Flux DJ", start_url: "/start", scope: "/", display: "standalone", theme_color: "#ffffff", background_color: "#ffffff" });
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@|token|bouprod|e2e-/i);
    const expected = [["/icons/icon-192.png", 192, "any"], ["/icons/icon-512.png", 512, "any"], ["/icons/maskable-512.png", 512, "maskable"]] as const;
    expect(m.icons.map((i: { src: string; purpose: string }) => [i.src, i.purpose])).toEqual(expected.map(([src, , purpose]) => [src, purpose]));
    for (const [src, size] of expected) {
      const icon = await request.get(src);
      expect(icon.status()).toBe(200);
      expect(icon.headers()["content-type"]).toBe("image/png");
      expect(pngSize(await icon.body())).toEqual({ width: size, height: size });
    }

    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Flux DJ");
    // Zoom stays available.
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toBe("width=device-width, initial-scale=1");
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    const appleIcon = await request.get(apple!);
    expect(appleIcon.headers()["content-type"]).toBe("image/png");
    expect(pngSize(await appleIcon.body())).toEqual({ width: 180, height: 180 });
    expect((await request.get("/favicon.ico")).headers()["content-type"]).toBe("image/x-icon");

    // Chromium's own verdict: installable without a service worker.
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
    expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  });

  test("/start sends signed-out visitors to sign in, staff to their workspace and clients to /my", async ({ browser }) => {
    const anon = await browser.newContext(PHONE);
    const a = await anon.newPage();
    await a.goto("/start");
    await expect(a).toHaveURL(/\/login$/);
    await anon.close();

    const staffContext = await browser.newContext(PHONE);
    const staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    await staff.goto("/start");
    await expect(staff).toHaveURL(new RegExp(`/staff/${tenant.slug}$`));
    await staffContext.close();

    const clientContext = await browser.newContext(PHONE);
    const client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    await client.goto("/start");
    await expect(client).toHaveURL(/\/my$/);
    await expect(client.getByRole("link", { name: `Plan E2E PWA Wedding ${run}` })).toBeVisible();
    await clientContext.close();

    // Both roles: staff of one business and a client elsewhere -> the staff workspace, as /staff already does.
    const dual = `e2e-pwa-dual-${run}@example.test`;
    const { data: user } = await must(admin.auth.admin.createUser({ email: dual, email_confirm: true }));
    await must(admin.from("tenant_memberships").insert({ tenant_id: otherTenant.id, user_id: user.user!.id, role: "staff" }));
    const dualClient = randomUUID();
    await must(admin.from("clients").insert({ id: dualClient, tenant_id: tenant.id, name: "Dual Role", email: dual }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: dualClient, is_primary: false, can_sign: false }));
    await must(admin.from("event_access").insert({ tenant_id: tenant.id, event_id: eventId, client_id: dualClient, user_id: user.user!.id }));
    const dualContext = await browser.newContext(PHONE);
    const d = await dualContext.newPage();
    await signInStaff(d, dual);
    await d.goto("/start");
    await expect(d).toHaveURL(new RegExp(`/staff/${otherTenant.slug}$`));
    await d.goto("/my");
    await expect(d.getByRole("link", { name: "Go to your staff workspace" })).toBeVisible();
    await dualContext.close();

    // Several businesses: the existing chooser.
    await must(admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: user.user!.id, role: "staff" }));
    const multiContext = await browser.newContext(PHONE);
    const mpage = await multiContext.newPage();
    await signInWithLink(mpage, dual); // signInStaff expects a single business's dashboard
    await mpage.goto("/start");
    await expect(mpage).toHaveURL(/\/staff$/);
    await expect(mpage.getByRole("heading", { name: "Choose a business" })).toBeVisible();
    await multiContext.close();
  });

  test("install help: native prompt, iPhone Safari steps, nothing on other platforms, dismissible, hidden when installed", async ({ browser }) => {
    // Desktop Chromium without an install prompt: nothing to offer.
    const desktop = await browser.newContext();
    const dp = await desktop.newPage();
    await signInStaff(dp, tenant.ownerEmail);
    await expect(dp.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(dp.getByTestId("install-help")).toHaveCount(0);
    // The browser offers installation: the card uses the native prompt.
    await dp.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & Record<string, unknown>;
      e.prompt = async () => void ((window as unknown as Record<string, unknown>).prompted = true);
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(e);
    });
    const help = dp.getByTestId("install-help");
    await expect(help).toContainText("It still needs an internet connection.");
    await help.getByRole("button", { name: "Install" }).click();
    expect(await dp.evaluate(() => (window as unknown as Record<string, unknown>).prompted)).toBe(true);
    await expect(help).toHaveCount(0); // a prompt can be used once
    await desktop.close();

    // Android Chrome before any prompt: no iPhone instructions.
    const android = await browser.newContext({ ...PHONE, userAgent: ANDROID_CHROME });
    const ap = await android.newPage();
    await signInWithLink(ap, clientEmail);
    await ap.goto("/my");
    await expect(ap.getByRole("heading", { name: "Your event planning" })).toBeVisible();
    await expect(ap.getByTestId("install-help")).toHaveCount(0);
    await android.close();

    // iPhone Safari: Share, then Add to Home Screen; dismissal is remembered.
    const iphone = await browser.newContext({ ...PHONE, userAgent: IPHONE_SAFARI });
    const ip = await iphone.newPage();
    await signInWithLink(ip, clientEmail);
    await ip.goto("/my");
    await expect(ip.getByTestId("install-help-ios")).toContainText("In Safari, tap Share, then Add to Home Screen.");
    await expect(ip.getByTestId("install-help")).not.toContainText(/offline|works without/i);
    expect(await noSideways(ip)).toBeLessThanOrEqual(0);
    await ip.getByTestId("install-help").getByRole("button", { name: "Not now" }).click();
    await expect(ip.getByTestId("install-help")).toHaveCount(0);
    await ip.reload();
    await expect(ip.getByRole("heading", { name: "Your event planning" })).toBeVisible();
    await expect(ip.getByTestId("install-help")).toHaveCount(0);
    await iphone.close();

    // Chrome on iPhone: it must be added from Safari.
    const crios = await browser.newContext({ ...PHONE, userAgent: IPHONE_CHROME });
    const cp = await crios.newPage();
    await signInWithLink(cp, clientEmail);
    await cp.goto("/my");
    await expect(cp.getByTestId("install-help-ios-other")).toContainText("Open this page in Safari");
    await crios.close();

    // Already running from the home screen: no help.
    const installed = await browser.newContext({ ...PHONE, userAgent: IPHONE_SAFARI });
    await installed.addInitScript(STANDALONE);
    const sp = await installed.newPage();
    await signInWithLink(sp, clientEmail);
    await sp.goto("/my");
    await expect(sp.getByRole("heading", { name: "Your event planning" })).toBeVisible();
    await expect(sp.getByTestId("install-help")).toHaveCount(0);
    await installed.close();
  });

  test("standalone on a phone: PDFs go to the share sheet with the app's session; offline is said plainly", async ({ browser }) => {
    const app: BrowserContext = await browser.newContext({ ...PHONE, userAgent: IPHONE_SAFARI });
    await app.addInitScript(STANDALONE);
    await app.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      Object.defineProperty(navigator, "canShare", { value: (d: { files?: File[] }) => Boolean(d.files?.length) });
      Object.defineProperty(navigator, "share", {
        value: async (d: { files: File[] }) => {
          const f = d.files[0];
          w.shared = { name: f.name, type: f.type, size: f.size, head: new TextDecoder().decode((await f.arrayBuffer()).slice(0, 5)) };
        },
      });
    });
    const page = await app.newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/events/${eventId}/run-sheet`);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
    await expect(page.getByText("Opens your phone's share options: save to Files or print.")).toBeVisible();
    await page.getByRole("link", { name: "Download run sheet PDF" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).shared)).toMatchObject({
      name: `run-sheet-e2e-pwa-wedding-${run}-2027-08-14.pdf`, type: "application/pdf", head: "%PDF-",
    });
    expect(page.url()).toContain("/run-sheet"); // still in the app, not stranded in a PDF viewer

    // Offline: an honest notice, and a failed download says so instead of pretending.
    await app.setOffline(true);
    await expect(page.getByTestId("offline-notice")).toContainText("changes can't be saved until you're back online");
    await page.getByRole("link", { name: "Download run sheet PDF" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't get the PDF" })).toBeVisible();
    await app.setOffline(false);
    await expect(page.getByTestId("offline-notice")).toHaveCount(0);

    // Without browser controls every page offers a way on.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${tenant.slug}$`));
    const missing = await page.goto(`/staff/${tenant.slug}/events/${randomUUID()}/run-sheet`);
    expect(missing?.status()).toBe(404);
    await page.getByRole("link", { name: "Go to Flux DJ" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${tenant.slug}$`));

    // Nothing private kept on the device: no service worker, no caches, only the help preference.
    const storage = await page.evaluate(async () => ({
      workers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
      caches: (await caches.keys()).length,
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    expect(storage).toMatchObject({ workers: 0, caches: 0 });
    expect(storage.local.every((k) => k === "flux:install-help-dismissed")).toBe(true);
    await app.close();
  });

  test("the client's pages work standalone on a phone: planning, contract and a way back to /my", async ({ browser }) => {
    const app = await browser.newContext({ ...PHONE, userAgent: IPHONE_SAFARI });
    await app.addInitScript(STANDALONE);
    const page = await app.newPage();
    await signInWithLink(page, clientEmail);
    await page.goto("/start");
    await expect(page).toHaveURL(/\/my$/);
    await page.getByRole("link", { name: `Plan E2E PWA Wedding ${run}` }).click();
    await expect(page.getByTestId("editing-notice")).toBeVisible();
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
    // Typing scrolls the field into view and saves as before.
    const guests = page.getByLabel("Guest count (needed)");
    await guests.fill("140");
    await expect(guests).toBeInViewport();
    await expect(page.getByTestId("section-basics").getByText("All changes saved")).toBeVisible();
    // Private pages are never cacheable: "private, no-store" in production (checked against
    // `next start`); `next dev` replaces it with its own "no-cache, must-revalidate".
    const res = await page.goto(page.url());
    expect(res!.headers()["cache-control"]).toMatch(/no-store|no-cache/);
    expect(res!.headers()["cache-control"]).not.toContain("public");
    await page.getByRole("link", { name: "Your events and contracts" }).click();
    await expect(page).toHaveURL(/\/my$/);
    await page.getByRole("link", { name: `E2E PWA Wedding ${run}`, exact: true }).click();
    await expect(page).toHaveURL(/\/contracts\//);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: "Your events and contracts" }).click();
    await expect(page).toHaveURL(/\/my$/);
    await app.close();
  });
});
