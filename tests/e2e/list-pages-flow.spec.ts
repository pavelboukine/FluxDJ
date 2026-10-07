/**
 * The staff Events and Clients lists in real browsers, in dedicated test
 * businesses: archived records left out by default and revealed with
 * badges, search and filters combined over every record (not a loaded
 * page), empty states and Clear filters, URL state across Back, pagination,
 * the dashboard's Add client link, client archive and restore with the
 * event link kept, another business refused, and phone layouts. The date
 * and search rules are tested in pgTAP (37_staff_lists_client_archiving).
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { bookLocally } from "../support/local-sql";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DAY = 86_400_000;
const dateIn = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * DAY));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}

test.describe.serial("events and clients lists", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let empty: TestTenant;
  const run = randomUUID().slice(0, 6);
  const ids: Record<string, string> = {};

  async function client(key: string, name: string, extra: { phone?: string; archived?: boolean } = {}) {
    ids[key] = randomUUID();
    await must(admin.from("clients").insert({ id: ids[key], tenant_id: tenant.id, name, email: `e2e-lists-${key}-${run}@example.test`, phone: extra.phone ?? null }));
    if (extra.archived) await must(admin.from("clients").update({ archived_at: new Date().toISOString() }).eq("id", ids[key]));
  }
  async function event(key: string, title: string, days: number, contact: string, extra: { venue?: string; archived?: boolean } = {}) {
    ids[key] = randomUUID();
    await must(admin.from("events").insert({ id: ids[key], tenant_id: tenant.id, title, event_type: "wedding", event_date: dateIn(days), timezone: "America/Toronto", venue_name: extra.venue ?? null }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: ids[key], client_id: ids[contact], is_primary: true, can_sign: true }));
    if (extra.archived) await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", ids[key]));
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("lists");
    empty = await createTestTenant("lists-empty");
    await client("ana", "Ana Garcia");
    await client("ben", "Ben Okafor", { phone: "514 555 0101" });
    await client("cara", "Cara Today");
    await client("old", "Old Lead", { archived: true });
    for (let i = 1; i <= 26; i++) await client(`f${i}`, `Filler ${String(i).padStart(2, "0")}`);
    await event("wedding", "Garcia wedding", 1, "ana", { venue: "Château Ramezay" });
    await event("gala", "Okafor gala", 10, "ben");
    await event("anniversary", "Garcia anniversary", -30, "ana", { venue: "Le Windsor" });
    await event("tasting", "Tasting", 3, "old", { archived: true });
    await event("today", "Cara's brunch", 0, "cara");
    bookLocally(ids.gala);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(empty);
  });

  test("events: upcoming by default, archived revealed on request, search and filters combined", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}/events`;
    await page.goto(base);
    const rows = page.getByTestId("event-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Cara's brunch");
    await expect(rows.nth(0)).toContainText("Today");
    await expect(rows.nth(1)).toContainText("Garcia wedding");
    await expect(rows.nth(1)).toContainText("Tomorrow");
    await expect(rows.nth(1)).toContainText("Ana Garcia · Château Ramezay");
    await expect(rows.nth(2)).toContainText("Ben Okafor · Venue not set");
    await expect(rows.nth(2)).toContainText("Booked");
    await expect(rows.nth(2)).not.toContainText(/Today|Tomorrow/);
    await expect(page.getByTestId("list-result")).toContainText("3 upcoming events, nearest first. 1 archived event also matches.");
    await shot(page, info, "events-desktop");

    // Include archived (the checkbox applies at once) reveals it with a badge.
    await page.getByLabel("Include archived").check();
    await expect(page).toHaveURL(new RegExp(`${base}\\?archived=1$`));
    await expect(rows.filter({ hasText: "Tasting" })).toContainText("Archived");
    await shot(page, info, "events-archived-included");

    // Search covers every date and the primary contact; filters combine.
    await page.goto(`${base}?view=all&q=garcia`);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Garcia wedding");
    await expect(rows.nth(1)).toContainText("Garcia anniversary"); // latest date first
    await page.goto(`${base}?view=past`);
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("Garcia anniversary");
    await page.goto(`${base}?view=all&status=booked&q=okafor`);
    await expect(rows).toHaveCount(1);
    await shot(page, info, "events-filtered");
    await page.goto(`${base}?view=all&status=booked&q=garcia`);
    await expect(page.getByTestId("events-no-results")).toContainText("No events match these filters.");
    await page.getByTestId("events-no-results").getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(rows).toHaveCount(3);
    // The filter fields show the cleared state too.
    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(page.getByLabel("Status")).toHaveValue("");
    await expect(page.getByLabel("Dates")).toHaveValue("upcoming");

    // The URL keeps the state across a visit to an event and Back.
    await page.getByLabel("Search").fill("okafor");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=okafor/);
    await rows.first().getByRole("link", { name: "Okafor gala" }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${ids.gala}$`));
    await page.goBack();
    await expect(page).toHaveURL(/q=okafor/);
    await expect(page.getByLabel("Search")).toHaveValue("okafor");
    await expect(rows).toHaveCount(1);
    await page.context().close();
  });

  test("clients: active by default, search by name or email, archived on request, pages", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}/clients`;
    await page.goto(base);
    const rows = page.getByTestId("client-row");
    await expect(rows).toHaveCount(25);
    await expect(page.getByTestId("list-result")).toContainText("29 active clients, by name. Showing 1–25 of 29. 1 archived client also matches.");
    // The next event is labelled; Today/Tomorrow only when true in the event's own time zone.
    const fmt = (days: number) => new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${dateIn(days)}T00:00:00Z`));
    await expect(rows.nth(0)).toContainText(`Ana Garcia`);
    await expect(rows.nth(0)).toContainText(`Next event: ${fmt(1)} (Tomorrow) · Garcia wedding`);
    await expect(rows.nth(1)).toContainText("514 555 0101");
    await expect(rows.nth(1)).toContainText(`Next event: ${fmt(10)} · Okafor gala`);
    await expect(rows.nth(1)).not.toContainText(/Today|Tomorrow|Next (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
    await expect(rows.nth(2)).toContainText(`Next event: ${fmt(0)} (Today) · Cara's brunch`);
    await expect(rows.nth(0).getByTestId("next-event")).toHaveAttribute("href", `/staff/${tenant.slug}/events/${ids.wedding}`);
    await expect(page.getByTestId("client-list")).not.toContainText("Old Lead");
    await shot(page, info, "clients-desktop");
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2$/);
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(3)).toContainText("Filler 26");

    await page.goto(`${base}?q=old`);
    await expect(page.getByTestId("clients-no-results")).toContainText("No clients match this search. 1 archived client matches but is hidden.");
    await page.getByTestId("clients-no-results").getByRole("link", { name: "Include archived" }).click();
    await expect(page).toHaveURL(/q=old&archived=1$/);
    await expect(rows.filter({ hasText: "Old Lead" })).toContainText("Archived");
    await shot(page, info, "clients-archived-included");
    await page.goto(`${base}?q=${encodeURIComponent(`lists-ben-${run}`)}`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ben Okafor");
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await page.context().close();
  });

  test("archiving a client hides them from new work and keeps their events; restoring brings them back", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const before = (await must(admin.from("event_clients").select("event_id, is_primary, can_sign").eq("client_id", ids.ana).order("event_id"))).data;
    await page.goto(`/staff/${tenant.slug}/clients/${ids.ana}`);
    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the client" });
    await expect(dialog).toContainText("Their 2 events stay as they are, with them as a contact.");
    await expect(dialog).toContainText("a proposal can't be sent to them as primary contact");
    await shot(page, info, "client-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive client" }).click();
    await expect(page.getByText("This client is archived.")).toBeVisible();
    await expect(page.locator("[data-slot=badge]", { hasText: "Archived" })).toBeVisible();
    const { data: row } = await must(admin.from("clients").select("archived_at").eq("id", ids.ana).single());
    expect(row!.archived_at).not.toBeNull();
    expect((await must(admin.from("event_clients").select("event_id, is_primary, can_sign").eq("client_id", ids.ana).order("event_id"))).data).toEqual(before);

    // Hidden from the list and from new contacts; still on their event.
    await page.goto(`/staff/${tenant.slug}/clients`);
    await expect(page.getByTestId("client-list")).not.toContainText("Ana Garcia");
    await page.goto(`/staff/${tenant.slug}/events/${ids.wedding}`);
    await expect(page.locator("#contacts")).toContainText("Ana Garcia");
    await expect(page.locator("#contacts")).toContainText("Archived client");
    await page.goto(`/staff/${tenant.slug}/events/new`);
    await expect(page.locator("select").filter({ hasText: "Ben Okafor" }).locator("option", { hasText: "Ana Garcia" })).toHaveCount(0);

    await page.goto(`/staff/${tenant.slug}/clients/${ids.ana}`);
    await page.getByRole("button", { name: "Restore client" }).click();
    await expect(page.getByText("Client restored.")).toBeVisible();
    await expect(page.getByText("This client is archived.")).toHaveCount(0);
    expect((await must(admin.from("clients").select("archived_at").eq("id", ids.ana).single())).data!.archived_at).toBeNull();
    await page.context().close();
  });

  test("empty businesses, the dashboard's Add client link, and another business refused", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, empty.ownerEmail);
    await page.goto(`/staff/${empty.slug}/events`);
    await expect(page.getByTestId("events-empty")).toContainText("No events yet.");
    await shot(page, info, "events-empty", false);
    await page.goto(`/staff/${empty.slug}/clients`);
    await expect(page.getByTestId("clients-empty")).toContainText("No clients yet.");
    await expect(page.locator("#add-client")).toBeVisible();
    await shot(page, info, "clients-empty", false);

    await page.goto(`/staff/${empty.slug}`);
    await page.getByRole("main").getByRole("link", { name: "Add client" }).click();
    await expect(page).toHaveURL(/\/clients#add-client$/);
    await expect(page.locator("#add-client")).toBeVisible();
    await expect(page.getByLabel("Name")).toBeInViewport();
    await expect(page.getByLabel("Name")).toBeFocused();

    expect((await page.goto(`/staff/${tenant.slug}/events`))?.status()).toBe(404);
    expect((await page.goto(`/staff/${tenant.slug}/clients`))?.status()).toBe(404);
    await page.context().close();
  });

  test("add client: one entry point, focused form, errors and typed values kept, cancel asks first", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}/clients`;
    await page.goto(base);
    // No separate bar: the search bar is the first thing under the header, and the form is hidden.
    await expect(page.locator("#add-client")).toBeHidden();
    await expect(page.getByText("Add a client")).toBeHidden();
    const header = (await page.getByRole("heading", { name: "Clients", level: 1 }).boundingBox())!;
    const search = (await page.getByRole("search").boundingBox())!;
    expect(search.y).toBeGreaterThan(header.y);
    expect(await page.getByRole("button", { name: "Add client" }).count()).toBe(0); // the submit button is hidden with the form

    await page.getByRole("main").getByRole("link", { name: "Add client" }).click();
    await expect(page.locator("#add-client")).toBeVisible();
    await expect(page.getByLabel("Name")).toBeFocused();
    await shot(page, info, "clients-add-open", false);

    // A validation error keeps what was typed.
    await page.getByLabel("Name").fill("Dana Lee");
    await page.getByLabel("Email").fill("dana@");
    await page.getByLabel("Email").evaluate((el: HTMLInputElement) => (el.type = "text")); // reach the server's own check
    await page.locator("#add-client").getByRole("button", { name: "Add client" }).click();
    await expect(page.locator("#add-client").getByRole("alert")).toContainText("Enter a valid client email.");
    await expect(page.getByLabel("Name")).toHaveValue("Dana Lee");
    await expect(page.locator("#add-client")).toContainText("Unsaved changes");

    // Cancel with typed details asks first; declining keeps everything.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#add-client")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue("dana@");

    // A valid save adds the client and clears the form.
    await page.getByLabel("Email").fill(`e2e-lists-dana-${run}@example.test`);
    await page.locator("#add-client").getByRole("button", { name: "Add client" }).click();
    await expect(page.locator("#add-client").getByRole("status").filter({ hasText: "Added Dana Lee." })).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("");
    await expect(page.getByTestId("client-list")).toContainText("Dana Lee");

    // Cancel with nothing typed simply closes; typing then accepting the prompt discards.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#add-client")).toBeHidden();
    await page.getByRole("main").getByRole("link", { name: "Add client" }).click();
    await page.getByLabel("Name").fill("Not saved");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#add-client")).toBeHidden();
    await page.getByRole("main").getByRole("link", { name: "Add client" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("");
    await page.context().close();
  });

  test("on a phone: stacked rows, filters reachable, nothing scrolls sideways", async ({}, info) => {
    for (const width of [390, 320]) {
      const page = await (await browser.newContext({ ...PHONE, viewport: { width, height: 844 } })).newPage();
      await signInStaff(page, tenant.ownerEmail);
      for (const path of ["events", "events?archived=1&view=all", "clients", "clients?archived=1"]) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        await expect(page.getByRole("search")).toBeVisible();
        expect(await sideways(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      }
      if (width === 390) {
        await page.goto(`/staff/${tenant.slug}/events`);
        await shot(page, info, "events-phone");
        await page.goto(`/staff/${tenant.slug}/clients`);
        await shot(page, info, "clients-phone");
      }
      await page.context().close();
    }
  });
});
