/**
 * The staff dashboard in real browsers, in dedicated test businesses: a new,
 * empty workspace (setup checklist, owner and staff wording, calm empty
 * states) and a busy one (upcoming events in order, a real submitted
 * proposal, planning closing and closed, a deposit, an email failure, the
 * attention cap and "Show all"), on desktop and a phone, with working links.
 * The rules behind each item are tested in pgTAP (36_staff_dashboard).
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";
import { bookLocally, markAwaitingDepositLocally, placePlanningDeadline } from "../support/local-sql";

const run = randomUUID().slice(0, 6);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DAY = 86_400_000;
/** A date `days` from today in Toronto (the test events' time zone). */
const dateIn = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * DAY));

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Fixture writes fail loudly instead of leaving a half-built business. */
async function ok<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

async function addEvent(tenant: TestTenant, title: string, days: number, opts: { venue?: string; client?: string; archived?: boolean } = {}) {
  const id = randomUUID();
  await ok(admin.from("events").insert({
    id, tenant_id: tenant.id, title, event_type: "wedding", event_date: dateIn(days), timezone: "America/Toronto",
    venue_name: opts.venue ?? null, archived_at: opts.archived ? new Date().toISOString() : null,
  }));
  if (opts.client) {
    const clientId = randomUUID();
    await ok(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: opts.client, email: `e2e-dash-${id.slice(0, 8)}@example.test` }));
    await ok(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: id, client_id: clientId, is_primary: true, can_sign: true }));
  }
  return id;
}

test.describe.serial("staff dashboard", () => {
  let browser: Browser;
  let empty: TestTenant;
  let busy: TestTenant;
  const staffEmail = `e2e-dash-staff-${run}@example.test`;
  const ids: Record<string, string> = {};

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    // A brand-new workspace: nothing saved yet.
    empty = await createTestTenant("dash-empty");
    await ok(admin.from("tenants").update({ business_address: null, contact_email: null, tax_config: [], tax_categories: {} }).eq("id", empty.id));
    const { data: staffUser } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await ok(admin.from("tenant_memberships").insert({ tenant_id: empty.id, user_id: staffUser.user!.id, role: "staff" }));

    // A configured business with work in progress.
    busy = await createTestTenant("dash-busy", { catalog: true });
    const templateId = randomUUID();
    await ok(admin.from("contract_templates").insert({ id: templateId, tenant_id: busy.id, name: "Wedding agreement" }));
    const versionId = randomUUID();
    await admin.from("contract_template_versions").insert({ id: versionId, tenant_id: busy.id, template_id: templateId, version_number: 1, title: "Wedding DJ agreement", sections: [{ heading: "Services", body: "The DJ performs." }] });
    const { data: owner } = await admin.from("tenant_memberships").select("user_id").eq("tenant_id", busy.id).eq("role", "owner").single();
    // Published for client use as the owner's confirmation records it (the editor is covered by contract-flow.spec.ts).
    const { data: statement } = await admin.rpc("client_use_statement_current");
    const published = await admin.from("contract_template_versions").update({
      published_at: new Date().toISOString(), usage: "client_use", client_use_statement_version: (statement as { version: string }).version,
      client_use_confirmed_by_user_id: owner!.user_id,
    }).eq("id", versionId);
    if (published.error) throw published.error;

    ids.garcia = await addEvent(busy, "Garcia wedding", 1, { venue: "Château Ramezay", client: "Ana Garcia" });
    ids.chen = await addEvent(busy, "Chen anniversary", 5, { venue: "Le Windsor", client: "Wei Chen" });
    ids.okafor = await addEvent(busy, "Okafor gala", 9, { venue: "Arsenal", client: "Ada Okafor" });
    ids.patel = await addEvent(busy, "Patel sangeet", 12, { client: "Riya Patel" });
    ids.roy = await addEvent(busy, "Roy wedding", 15, { venue: "Gare Windsor", client: "Luc Roy" });
    ids.kim = await addEvent(busy, "Kim birthday", 18, { venue: "Loft 9", client: "Min Kim" });
    ids.silva = await addEvent(busy, "Silva wedding", 21, { venue: "Marché Bonsecours", client: "Bea Silva" });
    ids.nguyen = await addEvent(busy, "Nguyen party", 24, { client: "Tam Nguyen" });
    ids.dubois = await addEvent(busy, "Dubois wedding", 40, { venue: "Hôtel Place d'Armes", client: "Marc Dubois" });
    ids.past = await addEvent(busy, "Last week's party", -7, { client: "Past Client" });
    ids.archived = await addEvent(busy, "Archived tasting", 3, { client: "Old Lead", archived: true });

    for (const [key, deadlineHours] of [["garcia", -24], ["okafor", 50], ["roy", 4 * 24], ["kim", 6 * 24], ["silva", 5 * 24]] as const) {
      bookLocally(ids[key]);
      placePlanningDeadline(ids[key], deadlineHours);
    }
    markAwaitingDepositLocally(ids.patel);
    await admin.from("email_outbox").insert({
      tenant_id: busy.id, event_type: "proposal_sent", recipient_email: `e2e-dash-bounce-${run}@example.test`, entity_type: "proposal",
      entity_id: randomUUID(), dedup_key: `e2e-dash-failed-${run}`, status: "failed", attempts: 5, last_error: "Mailbox unavailable",
    });
    await admin.from("email_outbox").insert({
      tenant_id: busy.id, event_type: "proposal_sent", recipient_email: `e2e-dash-retry-${run}@example.test`, entity_type: "proposal",
      entity_id: randomUUID(), dedup_key: `e2e-dash-retry-${run}`, status: "pending", attempts: 2, last_error: "Timeout", next_attempt_at: new Date(Date.now() + DAY).toISOString(),
    });
  });

  test.afterAll(async () => {
    await archiveTestTenant(empty);
    await archiveTestTenant(busy);
  });

  test("a new workspace: a setup checklist from saved data, calm empty states, no count tiles", async ({}, info) => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, empty.ownerEmail);
    await page.goto(`/staff/${empty.slug}`);
    const checklist = page.getByTestId("setup-checklist");
    await expect(checklist).toContainText("0 of 5 done");
    for (const key of ["identity", "taxes", "packages", "proposal-template", "contract-template"]) {
      await expect(checklist.getByTestId(`setup-${key}`)).toHaveAttribute("data-done", "false");
    }
    await expect(checklist.getByRole("link", { name: "Legal name, address and contact email" })).toHaveAttribute("href", `/staff/${empty.slug}/settings`);
    await expect(checklist.getByRole("link", { name: "Taxes" })).toHaveAttribute("href", `/staff/${empty.slug}/settings#taxes`);
    await expect(checklist).not.toContainText("Only the owner");
    await expect(page.getByTestId("attention-empty")).toHaveText("Nothing needs your attention right now.");
    await expect(page.getByTestId("upcoming-empty")).toContainText("No upcoming events.");
    await expect(page.getByTestId("email-failures")).toHaveCount(0);
    await expect(page.getByText("Gear items")).toHaveCount(0); // the old count tiles are gone
    await shot(page, info, "empty-desktop");

    // Quick actions open the existing screens.
    await page.getByRole("link", { name: "Add client" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${empty.slug}/clients#add-client$`));
    await expect(page.locator("#add-client")).toBeInViewport();
    await page.goto(`/staff/${empty.slug}`);
    await page.getByRole("main").getByRole("link", { name: "New event" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${empty.slug}/events/new$`));
    await page.context().close();

    const staff = await (await browser.newContext(PHONE)).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${empty.slug}`);
    await expect(staff.getByTestId("setup-identity")).toContainText("Only the owner can complete this.");
    await expect(staff.getByTestId("setup-packages")).not.toContainText("Only the owner");
    expect(await sideways(staff)).toBeLessThanOrEqual(0);
    await shot(staff, info, "empty-phone-staff");
    await staff.context().close();
  });

  test("a busy business: upcoming events in order and the work that needs attention", async ({}, info) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, busy.ownerEmail);
    // A real proposal, sent by staff and submitted by the client.
    await sendProposalFromEventPage(page, busy, ids.chen);
    const { data: proposal } = await admin.from("proposals").select("id").eq("event_id", ids.chen).eq("status", "sent").single();
    await submitAsClient(busy, proposal!.id);

    await page.goto(`/staff/${busy.slug}`);
    await expect(page.getByTestId("setup-checklist")).toHaveCount(0); // everything required is saved
    const rows = page.getByTestId("upcoming-event");
    await expect(rows).toHaveCount(8);
    await expect(rows.nth(0)).toContainText("Garcia wedding");
    await expect(rows.nth(0)).toContainText("Tomorrow");
    await expect(rows.nth(0)).toContainText("Ana Garcia · Château Ramezay");
    await expect(rows.nth(0)).toContainText("Booked");
    await expect(rows.filter({ hasText: "Patel sangeet" })).toContainText("Riya Patel · Venue not set");
    await expect(rows.filter({ hasText: "Patel sangeet" })).toContainText("Signed · awaiting deposit");
    await expect(rows.filter({ hasText: "Chen anniversary" })).toContainText("pending approval");
    await expect(page.getByTestId("upcoming-list")).not.toContainText("Last week's party");
    await expect(page.getByTestId("upcoming-list")).not.toContainText("Archived tasting");
    await expect(page.getByTestId("upcoming-list")).not.toContainText("Dubois wedding"); // the ninth: beyond the list
    await expect(page.getByText("Showing the next 8.")).toBeVisible();

    const items = page.getByTestId("attention-item");
    await expect(page.getByTestId("attention-count")).toHaveText("7");
    await expect(items).toHaveCount(6);
    await expect(items.nth(0)).toContainText("Proposal ready to review");
    await expect(items.nth(0)).toContainText("Chen anniversary");
    await expect(items.nth(1)).toHaveAttribute("data-kind", "planning_closed");
    await expect(items.nth(1)).toContainText("Garcia wedding");
    await expect(items.nth(2)).toContainText("Planning closes in 2 days");
    await expect(items.nth(2)).toContainText("Okafor gala");
    await expect(page.getByTestId("email-failures")).toContainText("1 email couldn't be delivered");
    await shot(page, info, "busy-desktop");

    await page.getByRole("link", { name: "Show all 7" }).click();
    await expect(items).toHaveCount(7);
    await expect(items.filter({ hasText: "Signed · waiting for the deposit" })).toContainText("Patel sangeet");
    await page.getByRole("link", { name: "Show fewer" }).click();
    await expect(items).toHaveCount(6);

    // Every link leads where the work is done.
    await items.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/proposals/${proposal!.id}$`));
    await page.goto(`/staff/${busy.slug}`);
    await items.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/events/${ids.garcia}/planning$`));
    await page.goto(`/staff/${busy.slug}`);
    await rows.filter({ hasText: "Kim birthday" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/events/${ids.kim}$`));
    await page.goto(`/staff/${busy.slug}`);
    await page.getByTestId("email-failures").getByRole("link", { name: "Review emails" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/emails$`));
    await page.goto(`/staff/${busy.slug}`);
    await page.getByRole("link", { name: "View all events" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/events$`));
    await page.context().close();
  });

  test("on a phone: attention first, stacked rows, no sideways scrolling", async ({}, info) => {
    const page = await (await browser.newContext(PHONE)).newPage();
    await signInStaff(page, busy.ownerEmail);
    await page.goto(`/staff/${busy.slug}`);
    const attention = (await page.getByRole("heading", { name: "Needs attention" }).boundingBox())!;
    const upcoming = (await page.getByRole("heading", { name: "Upcoming events" }).boundingBox())!;
    expect(attention.y).toBeLessThan(upcoming.y);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    for (const row of await page.getByTestId("upcoming-event").all()) {
      const box = (await row.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.getByTestId("upcoming-event").filter({ hasText: "Roy wedding" }).click();
    await expect(page).toHaveURL(new RegExp(`/staff/${busy.slug}/events/${ids.roy}$`));
    await page.goto(`/staff/${busy.slug}`);
    await shot(page, info, "busy-phone");
    await page.context().close();
  });
});
