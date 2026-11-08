/**
 * A non-default logo size on a client page: the event hub of a booked event, as its
 * client sees it, on a desktop and on phones. The logo grows by exactly the chosen
 * size, keeps its shape, isn't clipped, doesn't push the page sideways, and the logo's
 * row grows only by the logo itself. Staff headers are covered by logo-size-flow.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { paddedDiscPng } from "../support/logo-fixtures";
import { bookEvent, must, sessionFor } from "./booking";
import { admin, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-client-logo-${run}@example.test`;
const VIEWPORTS = [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }];
// The client page limit (CLIENT_PAGE_LOGO): 2.25rem, times the size.
const DEFAULT_HEIGHT = 36;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A square logo registered as the upload would (service role); the returned function makes it active at a size, through the owner's own save. */
async function squareLogo(tenant: TestTenant) {
  const png = await paddedDiscPng(600, 0, [30, 64, 175]);
  const path = `${tenant.id}/logos/${randomUUID()}.png`;
  await must(admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" }));
  const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
  const { data: logoId } = await must(admin.rpc("register_tenant_logo", {
    p_tenant_id: tenant.id, p_user_id: owner!.user_id, p_storage_path: path, p_sha256: createHash("sha256").update(png).digest("hex"),
    p_byte_size: png.length, p_width: 600, p_height: 600, p_needs_dark_background: false,
  }));
  return async (percent: number) => {
    const { data: t } = await must(admin.from("tenants").select("branding_version").eq("id", tenant.id).single());
    await must((await sessionFor(tenant.ownerEmail)).rpc("update_tenant_branding", {
      p_tenant_id: tenant.id, p_expected_version: t!.branding_version, p_logo_id: logoId, p_primary_color: null as unknown as string, p_logo_size_percent: percent,
    }));
  };
}

async function measure(page: Page, name: string) {
  const logo: Locator = page.getByRole("main").getByRole("img", { name });
  await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  const box = (await logo.boundingBox())!;
  const slot = (await logo.locator("xpath=ancestor::span[contains(@class,'min-h-8')][1]").boundingBox())!;
  const row = (await logo.locator("xpath=ancestor::div[1]").boundingBox())!;
  const clipped = await logo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflow === "visible" && style.overflowX === "visible" && style.overflowY === "visible") continue;
      const p = node.getBoundingClientRect();
      if (r.left < p.left - 0.5 || r.right > p.right + 0.5 || r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5) return true;
    }
    return false;
  });
  return { box, slot, row, clipped };
}

test.describe.serial("client page logo size", () => {
  let tenant: TestTenant;
  let eventId = "";
  let setSize: (percent: number) => Promise<void>;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    tenant = await createTestTenant("client-logo", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam Rivera", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `Logo Size Party ${run}`, event_type: "party", event_date: "2027-10-02", venue_name: "Salle Logo" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    await bookEvent(tenant, eventId, clientEmail);
    setSize = await squareLogo(tenant);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the event hub shows the chosen size on a desktop and on phones, without clipping, overflow or extra height", async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: VIEWPORTS[0] })).newPage();
    const hub = `/${tenant.slug}/events/${eventId}`;
    await setSize(100);
    await signInWithLink(page, clientEmail, hub);
    await page.waitForURL(`**${hub}`);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await setSize(100);
      await page.reload();
      const before = await measure(page, tenant.displayName);
      expect(before.box.height).toBeCloseTo(DEFAULT_HEIGHT, 0); // 100% is today's size

      await setSize(130);
      await page.reload();
      const after = await measure(page, tenant.displayName);
      expect(after.box.height).toBeCloseTo(DEFAULT_HEIGHT * 1.3, 0);
      expect(after.box.width / after.box.height).toBeCloseTo(1, 1); // still square
      expect(after.clipped).toBe(false);
      expect(after.box.x).toBeGreaterThanOrEqual(0);
      expect(after.box.x + after.box.width).toBeLessThanOrEqual(viewport.width);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      // The logo's slot fits the logo exactly, and its row grows by no more than the logo did.
      expect(after.slot.height).toBeCloseTo(after.box.height, 0);
      expect(after.row.height - before.row.height).toBeLessThanOrEqual(after.box.height - before.box.height + 0.5);
      await expect(page.getByRole("heading", { level: 1, name: `Logo Size Party ${run}` })).toBeInViewport();
    }
    await page.context().close();
  });
});
