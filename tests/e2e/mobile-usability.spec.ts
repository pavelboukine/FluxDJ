/**
 * Staff pages on phones, in dedicated test businesses, with long realistic
 * names, addresses, titles and venues: the Emails page keeps status, Retry and
 * the failure explanation on screen, list fields use 16px text, Clients and
 * Events show their details in full, and important controls have a 44px tap
 * area. Desktop keeps its table, compact controls and one-line rows.
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must, sessionFor } from "./booking";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const HEIGHTS: Record<number, number> = { 320: 700, 390: 844, 430: 932 };
const phone = (width: number) => ({ viewport: { width, height: HEIGHTS[width] }, isMobile: true, hasTouch: true });
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const DAY = 86_400_000;
const dateIn = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * DAY));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The height that really responds to a tap at the control's centre line, including any invisible tap area. */
async function tapHeight(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await control.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    // Clear of the sticky header, so nothing covers the area being measured.
    if (top < 120) scrollBy(0, top - 120);
  });
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hits = (offset: number) => {
      const found = document.elementFromPoint(x, y + offset);
      return found !== null && (el === found || el.contains(found));
    };
    let up = 0;
    while (up < 40 && hits(-(up + 1))) up++;
    let down = 0;
    while (down < 40 && hits(down + 1)) down++;
    return up + down + 1;
  });
}

async function expectInsideScreen(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

/** Nothing cut off: the element's content fits its box. */
const fullyShown = (target: Locator) => target.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

test.describe.serial("staff pages on phones", () => {
  let browser: Browser;
  let tenant: TestTenant;
  const run = randomUUID().slice(0, 6);
  const LONG_ADDRESS = `alexandra.montgomery-fitzgerald.vandenberghe.${run}@events-and-celebrations.example.test`;
  const LONG_CLIENT = "Alexandra Montgomery-Fitzgerald";
  const CLIENT_EMAIL = `alexandra.montgomery.fitzgerald.${run}@example.test`;
  const PHONE_NUMBER = "514 555 0188";
  const LONG_TITLE = "Montgomery-Fitzgerald & Vandenberghe wedding celebration";
  const LONG_VENUE = "Hôtel Place d'Armes, Grand Ballroom, Old Montréal";
  const LIST_PAGES = ["events", "clients", "gear", "packages", "templates", "contract-templates", "planning-templates", "questions"];

  const open = async (options: object) => {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, tenant.ownerEmail);
    return page;
  };

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("mobile-usability", { catalog: true });

    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: LONG_CLIENT, email: CLIENT_EMAIL, phone: PHONE_NUMBER }));
    for (let i = 1; i <= 25; i++) {
      await must(admin.from("clients").insert({ tenant_id: tenant.id, name: `Zed Filler ${String(i).padStart(2, "0")}`, email: `filler-${i}-${run}@example.test` }));
    }
    const eventId = randomUUID();
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: LONG_TITLE, event_type: "wedding", event_date: dateIn(11), timezone: "America/Toronto", venue_name: LONG_VENUE }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));

    await must(admin.from("contract_templates").insert({ tenant_id: tenant.id, name: "Wedding DJ agreement" }));
    await must((await sessionFor(tenant.ownerEmail)).rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));

    const email = (key: string, row: Record<string, unknown>) => ({
      tenant_id: tenant.id, event_type: "proposal_approved", recipient_email: LONG_ADDRESS, entity_type: "proposal", entity_id: randomUUID(),
      payload: { event_title: LONG_TITLE, client_name: LONG_CLIENT, total_cents: 250_000, currency: "CAD" }, dedup_key: `e2e-mobile-${key}-${run}`, ...row,
    });
    await must(admin.from("email_outbox").insert(email("failed", { status: "failed", attempts: 5, max_attempts: 5, last_error: "Mailbox unavailable" })));
    await must(admin.from("email_outbox").insert(email("bounced", {
      status: "sent", attempts: 1, sent_at: new Date(Date.now() - DAY).toISOString(), provider_status: "bounced", provider_status_at: new Date(Date.now() - DAY).toISOString(),
      provider_detail: "550 5.1.1 The email account that you tried to reach does not exist.",
    })));
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("Emails: a long address keeps status, Retry and the explanation on screen", async () => {
    for (const width of [320, 390, 430]) {
      const page = await open(phone(width));
      await page.goto(`/staff/${tenant.slug}/emails`);
      expect(await sideways(page), `sideways at ${width}`).toBeLessThanOrEqual(0);

      const rows = page.getByTestId("email-row");
      for (const row of await rows.all()) {
        await expectInsideScreen(page, row.getByTestId("email-status"));
        await expectInsideScreen(page, row.getByTestId("email-details"));
        const recipient = row.getByTestId("email-recipient");
        await expect(recipient).toHaveText(LONG_ADDRESS);
        expect(await fullyShown(recipient)).toBe(true);
      }

      const failed = page.locator('[data-testid="email-row"][data-status="failed"]');
      await expect(failed.getByTestId("email-status")).toHaveText("Couldn't be sent");
      await expect(failed.getByTestId("email-details")).toBeVisible();
      const retry = failed.getByRole("button", { name: "Retry" });
      await expectInsideScreen(page, retry);
      expect(await tapHeight(retry)).toBeGreaterThanOrEqual(44);

      const bounced = page.locator('[data-testid="email-row"]').filter({ hasText: "Bounced" });
      await expect(bounced.getByTestId("email-details")).toContainText("550 5.1.1 The email account");
      await page.context().close();
    }
  });

  test("Emails: Retry works from a phone, and the desktop table is unchanged", async () => {
    const page = await open(phone(390));
    await page.goto(`/staff/${tenant.slug}/emails`);
    await page.locator('[data-testid="email-row"][data-status="failed"]').getByRole("button", { name: "Retry" }).click();
    // Requeued: the row leaves "failed" (and its Retry form, with any message, goes with it).
    await expect(page.locator('[data-testid="email-row"][data-status="failed"]')).toHaveCount(0);
    await page.context().close();

    const desktop = await open(DESKTOP);
    await desktop.goto(`/staff/${tenant.slug}/emails`);
    await expect(desktop.getByRole("columnheader")).toHaveText(["Email", "To", "Status", "Details"]);
    await expect(desktop.getByTestId("email-recipient").first()).toBeHidden();
    await expect(desktop.getByTestId("email-row").first().getByRole("cell").nth(1)).toHaveCSS("white-space", "nowrap");
    expect(await sideways(desktop)).toBeLessThanOrEqual(0);
    await desktop.context().close();
  });

  test("list search and filter fields: 16px and 44px on a phone, compact on desktop", async () => {
    const check = async (page: Page, font: string, height: string) => {
      for (const path of LIST_PAGES) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        const filters = page.getByRole("button", { name: /^Filters/ });
        if (await filters.isVisible()) await filters.click();
        const fields = page.getByRole("search").locator("input:not([type=checkbox]):visible, select:visible");
        await expect(fields.first(), path).toBeVisible();
        for (const field of await fields.all()) {
          await expect(field, path).toHaveCSS("font-size", font);
          await expect(field, path).toHaveCSS("height", height);
        }
      }
    };
    const page = await open(phone(390));
    await check(page, "16px", "44px");
    await page.context().close();
    const desktop = await open(DESKTOP);
    await check(desktop, "14px", "36px");
    await desktop.context().close();
  });

  test("Clients and Events show long details in full on a phone, on one line on desktop", async () => {
    for (const width of [320, 390, 430]) {
      const page = await open(phone(width));
      await page.goto(`/staff/${tenant.slug}/clients`);
      expect(await sideways(page), `clients at ${width}`).toBeLessThanOrEqual(0);
      const client = page.getByTestId("client-row").filter({ hasText: LONG_CLIENT });
      const contact = client.getByTestId("client-contact");
      await expect(contact).toContainText(CLIENT_EMAIL);
      await expect(contact).toContainText(PHONE_NUMBER);
      expect(await fullyShown(contact)).toBe(true);
      await expectInsideScreen(page, contact.getByText(PHONE_NUMBER));

      await page.goto(`/staff/${tenant.slug}/events`);
      expect(await sideways(page), `events at ${width}`).toBeLessThanOrEqual(0);
      const event = page.getByTestId("event-row").filter({ hasText: LONG_VENUE });
      const title = event.getByRole("link", { name: LONG_TITLE });
      expect(await fullyShown(title)).toBe(true);
      await expectInsideScreen(page, title);
      expect(await fullyShown(event.getByText(LONG_VENUE))).toBe(true);
      await page.context().close();
    }

    const desktop = await open(DESKTOP);
    await desktop.goto(`/staff/${tenant.slug}/clients`);
    await expect(desktop.getByTestId("client-row").filter({ hasText: LONG_CLIENT }).getByTestId("client-contact")).toHaveText(`${CLIENT_EMAIL} · ${PHONE_NUMBER}`);
    await desktop.goto(`/staff/${tenant.slug}/events`);
    await expect(desktop.getByTestId("event-row").filter({ hasText: LONG_VENUE }).getByRole("link", { name: LONG_TITLE })).toHaveCSS("text-overflow", "ellipsis");
    await desktop.context().close();
  });

  test("important controls have a 44px tap area on a phone and stay compact on desktop", async () => {
    const page = await open(phone(390));
    const base = `/staff/${tenant.slug}`;
    const expectTap = async (label: string, control: Locator) => expect(await tapHeight(control), label).toBeGreaterThanOrEqual(44);

    await page.goto(base);
    const main = page.getByRole("main");
    await expectTap("menu button", page.getByRole("button", { name: "Open menu" }));
    await expectTap("account button", page.getByRole("button", { name: "Account" }));
    await expectTap("new event", main.getByRole("link", { name: "Create event" }));
    await expectTap("view all events", main.getByRole("link", { name: "View all events" }));

    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByTestId("nav-drawer");
    for (const link of await drawer.getByRole("navigation").getByRole("link").all()) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(drawer).toBeHidden();

    await page.goto(`${base}/clients`);
    const filters = page.getByRole("search");
    await expectTap("filters button", filters.getByRole("button", { name: /^Filters/ }));
    await filters.getByRole("button", { name: /^Filters/ }).click();
    await expectTap("search button", filters.getByRole("button", { name: "Search" }));
    await expectTap("include archived", filters.getByText("Include archived"));
    await expectTap("client name", page.getByTestId("client-row").first().getByRole("link").first());
    await expectTap("next page", page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Next" }));

    for (const [path, name] of [["gear", "Wireless microphone"], ["packages", "Signature"], ["templates", "Wedding (DEMO)"]] as const) {
      await page.goto(`${base}/${path}`);
      await expectTap(path, main.getByRole("link", { name, exact: true }));
    }
    await page.goto(`${base}/contract-templates`);
    await expectTap("contract template", main.getByRole("link", { name: "Wedding DJ agreement", exact: true }));
    await page.goto(`${base}/planning-templates`);
    await expectTap("planning template", main.getByRole("link", { name: "Wedding", exact: true }));
    await page.goto(`${base}/questions`);
    await expectTap("question", main.getByRole("link", { name: /Where will the ceremony/ }));

    await page.goto(`${base}/settings`);
    const sections = page.getByRole("navigation", { name: "Settings sections" });
    for (const link of await sections.getByRole("link").all()) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expectTap("setup guide", main.getByRole("link", { name: "Setup guide" }));
    await expectTap("save branding", main.getByRole("button", { name: "Save branding" }));
    await expectTap("save booking policy", main.getByRole("button", { name: "Save booking policy" }));
    await expectTap("booking disclosure", main.getByText("From proposal to confirmed booking"));
    await expectTap("no tax", main.getByText("No tax", { exact: true }));
    await expect(main.getByLabel("Legal business name")).toHaveCSS("height", "44px");
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.context().close();

    const desktop = await open(DESKTOP);
    await desktop.goto(base);
    const sidebarLink = desktop.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Events" });
    expect((await sidebarLink.boundingBox())!.height).toBe(36);
    expect((await desktop.getByRole("button", { name: "Account" }).boundingBox())!.height).toBe(40);
    expect((await desktop.getByRole("main").getByRole("link", { name: "Create event" }).boundingBox())!.height).toBe(32);
    await desktop.goto(`${base}/settings`);
    await expect(desktop.getByLabel("Legal business name")).toHaveCSS("height", "32px");
    await desktop.context().close();
  });
});
