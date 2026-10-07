/**
 * The individual client page in real browsers, in a dedicated test business:
 * a readable overview with email and call links and honest gaps, the edit
 * form behind Edit details (errors and typed values kept, Cancel asks before
 * discarding), the client's events with their role on each (upcoming first by
 * each event's own date, then a paged history of past and archived events),
 * archive and restore leaving every event link unchanged, another business
 * refused, and the phone layout. E2E_SCREENSHOTS=1 also keeps review
 * screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { bookLocally } from "../support/local-sql";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DAY = 86_400_000;
const dateIn = (days: number, timeZone = "America/Toronto") => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() + days * DAY));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}

test.describe.serial("client page", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  const run = randomUUID().slice(0, 6);
  const ids: Record<string, string> = {};

  async function client(key: string, name: string, extra: { phone?: string; archived?: boolean } = {}) {
    ids[key] = randomUUID();
    await must(admin.from("clients").insert({ id: ids[key], tenant_id: tenant.id, name, email: `e2e-client-${key}-${run}@example.test`, phone: extra.phone ?? null }));
    if (extra.archived) await must(admin.from("clients").update({ archived_at: new Date().toISOString() }).eq("id", ids[key]));
  }
  /** An event with contacts: [client key, primary, signer]. */
  async function event(key: string, title: string, date: string, contacts: [string, boolean, boolean][], extra: { venue?: string; archived?: boolean; timezone?: string } = {}) {
    ids[key] = randomUUID();
    await must(admin.from("events").insert({ id: ids[key], tenant_id: tenant.id, title, event_type: "wedding", event_date: date, timezone: extra.timezone ?? "America/Toronto", venue_name: extra.venue ?? null }));
    for (const [c, primary, signer] of contacts) {
      await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: ids[key], client_id: ids[c], is_primary: primary, can_sign: signer }));
    }
    if (extra.archived) await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", ids[key]));
  }
  const links = (clientId: string) =>
    must(admin.from("event_clients").select("event_id, is_primary, can_sign").eq("client_id", clientId).order("event_id")).then((r) => r.data);

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("client-page");
    other = await createTestTenant("client-page-other");
    await client("rae", "Rae Morgan", { phone: "+1 514 555 0199" });
    await client("sam", "Sam Okafor");
    await client("noor", "Noor Haddad", { archived: true });
    // Rae's roles differ per event.
    await event("wedding", "Morgan wedding", dateIn(2), [["rae", true, true]], { venue: "Château Ramezay" });
    await event("gala", "Okafor gala", dateIn(20), [["sam", true, true], ["rae", false, false]]);
    await event("party", "Office party", dateIn(9), [["sam", true, false], ["rae", false, true]], { venue: "Le Windsor" });
    // Event-local dates: "today" on Kiritimati (UTC+14) is upcoming; "yesterday" in Pago Pago (UTC−11) is history.
    await event("island", "Island brunch", dateIn(0, "Pacific/Kiritimati"), [["rae", true, true]], { timezone: "Pacific/Kiritimati" });
    await event("pago", "Pago dinner", dateIn(-1, "Pacific/Pago_Pago"), [["rae", true, true]], { timezone: "Pacific/Pago_Pago" });
    // An archived future event belongs in the history.
    await event("tasting", "Menu tasting", dateIn(5), [["rae", true, true]], { archived: true });
    // Ten more past events, so the history pages.
    for (let i = 1; i <= 10; i++) await event(`past${i}`, `Past event ${String(i).padStart(2, "0")}`, dateIn(-10 * i - 30), [["rae", true, true]]);
    bookLocally(ids.wedding);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("overview, contact links, roles per event, upcoming first and paged history", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/clients/${ids.rae}`);
    await expect(page.getByRole("heading", { name: "Rae Morgan", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to clients" })).toHaveAttribute("href", `/staff/${tenant.slug}/clients`);
    await expect(page.locator("[data-slot=badge]", { hasText: "Active" })).toBeVisible();
    const details = page.locator("#details");
    await expect(details.getByRole("link", { name: `e2e-client-rae-${run}@example.test` })).toHaveAttribute("href", `mailto:e2e-client-rae-${run}@example.test`);
    await expect(details.getByRole("link", { name: "+1 514 555 0199" })).toHaveAttribute("href", "tel:+15145550199");
    // The form is behind Edit details.
    await expect(page.getByLabel("Name")).toBeHidden();
    await expect(page.getByRole("button", { name: "Save details" })).toBeHidden();

    const upcoming = page.getByTestId("client-upcoming").getByTestId("event-row");
    await expect(upcoming).toHaveCount(4);
    await expect(upcoming.nth(0)).toContainText("Island brunch");
    await expect(upcoming.nth(0)).toContainText("Today");
    await expect(upcoming.nth(1)).toContainText("Morgan wedding");
    await expect(upcoming.nth(1)).toContainText("Primary contact · Signer · Château Ramezay");
    await expect(upcoming.nth(1)).toContainText("Booked");
    await expect(upcoming.nth(2)).toContainText("Office party");
    await expect(upcoming.nth(2)).toContainText("Signer · Le Windsor");
    await expect(upcoming.nth(3)).toContainText("Okafor gala");
    await expect(upcoming.nth(3)).toContainText("Other contact · Venue not set");
    await expect(upcoming.nth(1).getByRole("link", { name: "Morgan wedding" })).toHaveAttribute("href", `/staff/${tenant.slug}/events/${ids.wedding}`);

    // History: archived and past, most recent first, ten at a time.
    const history = page.getByTestId("client-history").getByTestId("event-row");
    await expect(history).toHaveCount(10);
    await expect(history.nth(0)).toContainText("Menu tasting");
    await expect(history.nth(0)).toContainText("Archived");
    await expect(history.nth(1)).toContainText("Pago dinner");
    await expect(history.nth(1)).toContainText("Yesterday");
    await expect(history.nth(2)).toContainText("Past event 01");
    await shot(page, info, "client-overview-desktop");
    await page.getByRole("link", { name: "Older events" }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${ids.rae}\\?history=2#history$`));
    await expect(history).toHaveCount(2);
    await expect(history.nth(1)).toContainText("Past event 10");
    await expect(page.getByRole("link", { name: "Older events" })).toHaveCount(0);
    await page.getByRole("link", { name: "Newer events" }).click();
    await expect(history).toHaveCount(10);

    // Another client of the same events sees their own roles.
    await page.goto(`/staff/${tenant.slug}/clients/${ids.sam}`);
    const samRows = page.getByTestId("client-upcoming").getByTestId("event-row");
    await expect(samRows).toHaveCount(2);
    await expect(samRows.nth(0)).toContainText("Primary contact · Le Windsor");
    await expect(samRows.nth(1)).toContainText("Primary contact · Signer · Venue not set");
    await expect(page.getByTestId("client-history")).toHaveCount(0);
    await page.context().close();
  });

  test("an archived client with missing details: honest gaps, notice, restore", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/clients/${ids.noor}`);
    await expect(page.locator("[data-slot=badge]", { hasText: "Archived" })).toBeVisible();
    await expect(page.getByText("This client is archived.")).toBeVisible();
    await expect(page.locator("#details")).toContainText("No phone number");
    await expect(page.getByTestId("client-upcoming-empty")).toContainText("No events yet.");
    await expect(page.getByRole("button", { name: "Restore client" })).toBeVisible();
    await shot(page, info, "client-archived-desktop");
    await page.context().close();
  });

  test("edit details: focused form, errors keep typed values, cancel asks first, save returns to the overview", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/clients/${ids.sam}`);
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(page.getByLabel("Name")).toHaveValue("Sam Okafor");
    await expect(page.getByLabel("Phone (optional)")).toHaveValue("");

    // A server-side validation error keeps everything typed.
    await page.getByLabel("Name").fill("Samira Okafor");
    await page.getByLabel("Phone (optional)").fill("438 555 0123");
    await page.getByLabel("Email").fill("samira@");
    await page.getByLabel("Email").evaluate((el: HTMLInputElement) => (el.type = "text"));
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Enter a valid client email.");
    await expect(page.getByLabel("Name")).toHaveValue("Samira Okafor");
    await expect(page.getByLabel("Phone (optional)")).toHaveValue("438 555 0123");
    await expect(page.locator("#details")).toContainText("Unsaved changes");
    await shot(page, info, "client-edit-error", false);

    // Cancel asks; declining keeps the edits.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Email")).toHaveValue("samira@");

    // A valid save returns to the overview with the new details.
    const email = `e2e-client-samira-${run}@example.test`;
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("status").filter({ hasText: "Contact details saved." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Samira Okafor", level: 1 })).toBeVisible();
    await expect(page.locator("#details").getByRole("link", { name: email })).toBeVisible();
    await expect(page.locator("#details").getByRole("link", { name: "438 555 0123" })).toHaveAttribute("href", "tel:4385550123");
    await expect(page.getByRole("button", { name: "Edit details" })).toBeFocused();
    const row = (await must(admin.from("clients").select("name, email, phone").eq("id", ids.sam).single())).data;
    expect(row).toEqual({ name: "Samira Okafor", email, phone: "438 555 0123" });

    // Cancelling typed changes and accepting the prompt discards them.
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Samira Okafor");
    await page.getByLabel("Name").fill("Not saved");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Samira Okafor", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Samira Okafor");
    // Cancel with nothing changed simply closes.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Name")).toBeHidden();
    expect((await must(admin.from("clients").select("name").eq("id", ids.sam).single())).data!.name).toBe("Samira Okafor");
    await page.context().close();
  });

  test("archive and restore keep every event and role", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const before = await links(ids.rae);
    await page.goto(`/staff/${tenant.slug}/clients/${ids.rae}`);
    const manage = page.getByRole("region", { name: "Manage client" });
    await expect(manage).toContainText("It doesn't cancel their events or erase any history");
    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the client" });
    await expect(dialog).toContainText(`Their ${before!.length} events stay as they are, with them as a contact.`);
    await expect(dialog).toContainText("a contract can't be sent to them as signer");
    await shot(page, info, "client-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive client" }).click();
    await expect(page.getByText("This client is archived.")).toBeVisible();
    expect(await links(ids.rae)).toEqual(before);
    // Still listed with the same roles.
    await expect(page.getByTestId("client-upcoming").getByTestId("event-row")).toHaveCount(4);
    await expect(page.getByTestId("client-upcoming")).toContainText("Primary contact · Signer · Château Ramezay");

    await page.getByRole("button", { name: "Restore client" }).click();
    await expect(page.getByText("Client restored.")).toBeVisible();
    await expect(page.getByText("This client is archived.")).toHaveCount(0);
    expect(await links(ids.rae)).toEqual(before);
    expect((await must(admin.from("clients").select("archived_at").eq("id", ids.rae).single())).data!.archived_at).toBeNull();
    await page.context().close();
  });

  test("another business is refused; on a phone nothing scrolls sideways", async ({}, info) => {
    const outsider = await (await browser.newContext()).newPage();
    await signInStaff(outsider, other.ownerEmail);
    expect((await outsider.goto(`/staff/${tenant.slug}/clients/${ids.rae}`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${other.slug}/clients/${ids.rae}`))?.status()).toBe(404);
    await outsider.context().close();

    for (const width of [390, 320]) {
      const page = await (await browser.newContext({ ...PHONE, viewport: { width, height: 844 } })).newPage();
      await signInStaff(page, tenant.ownerEmail);
      await page.goto(`/staff/${tenant.slug}/clients/${ids.rae}`);
      await expect(page.getByTestId("client-upcoming")).toBeVisible();
      expect(await sideways(page), `overview at ${width}`).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "Edit details" }).click();
      expect(await sideways(page), `editing at ${width}`).toBeLessThanOrEqual(0);
      if (width === 390) await shot(page, info, "client-edit-phone");
      await page.getByRole("button", { name: "Cancel" }).click();
      if (width === 390) await shot(page, info, "client-overview-phone");
      await page.context().close();
    }
  });
});
