/**
 * Contacts and vendors, DJ expectations and the Party's music preferences in
 * a real browser against local Supabase, inside a dedicated test tenant with
 * a booked wedding (booking set up through the database functions the app
 * calls; see booking.ts). Everything about these sections goes through the UI:
 *   - the MC and officiant show where they are, not re-entered;
 *   - the day-of contact is one of the event's contacts (by reference, with
 *     a phone for the day) or someone else; a contact who leaves the event is
 *     shown as unavailable; the event's clients never change;
 *   - vendors: add, check phone and email, edit, reorder, remove with undo;
 *   - preferences read the announcement language from Event basics;
 *   - music styles or DJ's choice, slow songs, pending / failed / stale saves;
 *   - staff edit on a phone; hiding keeps answers; nothing contractual changes.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanMoment, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-contacts-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const contactsStatus = (page: Page) => page.locator("#plan-panel-contacts_vendors").getByTestId("section-status");

async function answers(eventId: string, key: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return ((await admin.from("event_plan_responses").select("answers").eq("item_id", item.id).maybeSingle()).data?.answers ?? null) as
    (Record<string, unknown> & { vendors?: { id: string; role: string; name?: string; business?: string; phone?: string; email?: string; notes?: string }[] }) | null;
}

async function addVendor(card: Locator, fill: (form: Locator) => Promise<void>) {
  const form = card.getByTestId("contacts_vendors-vendors-add");
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  await fill(form);
  await form.getByRole("button", { name: "Add", exact: true }).click();
}

test.describe.serial("contacts and preferences", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractual = "";
  let planningUrl = "";
  let staffPlanningUrl = "";
  const secondId = randomUUID();

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("contacts", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert([
      { id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail },
      { id: secondId, tenant_id: tenant.id, name: "Alex Rivera", email: `e2e-alex-${run}@example.test`, phone: "514 555-0199" },
    ]));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E Contacts Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14", venue_name: "Château E2E",
      internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert([
      { tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true },
      { tenant_id: tenant.id, event_id: eventId, client_id: secondId, is_primary: false, can_sign: false },
    ]));
    staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    await bookEvent(tenant, eventId, clientEmail);
    // The MC and officiant, entered in their own editors (covered by people-flow and planning-flow).
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const item = (key: string) => plan!.event_plan_items.find((i) => i.key === key)!.id;
    await must(staffDb.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: item("mc"), p_expected_revision: 0, p_answers: { mc: "other", name: "Kiara Okafor", contact: "kiara@example.test" } }));
    await must(staffDb.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: item("ceremony"), p_expected_revision: 0, p_answers: { officiant_name: "Rev. Sam Park", officiant_contact: "514 555-0177" } }));
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    await client.goto(planningUrl);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the day-of contact reuses an event contact by reference, with a phone for the day; the MC and officiant aren't re-entered", async () => {
    const card = await openPlanSection(client, "contacts_vendors");
    await expect(card.getByTestId("known-people")).toContainText("MC: Kiara Okafor · kiara@example.test");
    await expect(card.getByTestId("known-people")).toContainText("Officiant: Rev. Sam Park · 514 555-0177");
    await expect(card.getByTestId("known-people")).toContainText("No need to list them again as vendors.");

    await card.getByLabel("One of the event's contacts").check();
    await card.getByLabel("Contact", { exact: true }).selectOption({ label: "Jordan Lee (no phone on file)" });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("No phone number yet");
    await card.getByLabel("Phone for the day (needed)").fill("call me");
    await expect(card.getByText("Enter a phone number with 7 to 20 digits, such as 514 555-0100.")).toBeVisible();
    await card.getByLabel("Phone for the day (needed)").fill("514 555-0111");
    await expect(card.getByText("All changes saved")).toBeVisible();
    const { data: jordan } = await must(admin.from("clients").select("id, phone").eq("email", clientEmail).single());
    expect(await answers(eventId, "contacts_vendors")).toEqual({ day_of_source: "event_contact", day_of_client_id: jordan!.id, day_of_phone: "514 555-0111" });
    expect(jordan!.phone).toBeNull(); // the client's own record never changes

    // Someone else, then back to an event contact who has a phone on file.
    await card.getByLabel("Someone else").check();
    await card.getByLabel("Name (needed)").fill("Morgan Lee");
    await card.getByLabel("Phone (needed)").fill("+1 (514) 555-0142");
    await expect(card.getByText("All changes saved")).toBeVisible();
    await card.getByLabel("One of the event's contacts").check();
    await card.getByLabel("Contact", { exact: true }).selectOption({ label: "Alex Rivera (514 555-0199)" });
    await card.getByLabel("Different phone for the day (optional)").fill("");
    await expect(card.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "contacts_vendors")).toEqual({ day_of_source: "event_contact", day_of_client_id: secondId });
  });

  test("vendors: add with checked phone and email, edit, reorder, remove with undo; a reload keeps the order", async () => {
    const card = await openPlanSection(client, "contacts_vendors");
    await addVendor(card, async (form) => {
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form).toContainText("Choose a role.");
      await form.getByLabel("Role").selectOption({ label: "Photographer" });
      await form.getByLabel("Business name (optional)").fill("Lumière Photo");
      await form.getByLabel("Email (optional)").fill("jo@");
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form).toContainText("Enter an email address such as name@example.com.");
      await form.getByLabel("Email (optional)").fill("hello@lumiere.test");
    });
    await addVendor(card, async (form) => {
      await form.getByLabel("Role").selectOption({ label: "Planner or coordinator" });
      await form.getByLabel("Person's name").fill("Sasha Roy");
      await form.getByLabel("Phone (optional)").fill("514 555 0123");
      await form.getByLabel("Coordination notes (optional, shared with you and the DJ)").fill("Cue the DJ for the entrance");
    });
    await addVendor(card, async (form) => {
      await form.getByLabel("Role").selectOption({ label: "Live musician" });
      await form.getByLabel("Person's name").fill("String quartet");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    const rows = card.getByTestId("entry-row");
    await expect(rows.nth(1)).toContainText("2. Planner or coordinator: Sasha Roy");
    await expect(rows.nth(1)).toContainText("Shared notes: Cue the DJ for the entrance");
    await expect(contactsStatus(client)).toContainText("Complete");

    await card.getByRole("button", { name: 'Move "Sasha Roy" up' }).click();
    await card.getByRole("button", { name: 'Edit "String quartet"' }).click();
    await rows.filter({ hasText: "String quartet" }).getByLabel("Phone (optional)").fill("12");
    await expect(card.getByText("Fix the highlighted answer to save.")).toBeVisible();
    await rows.filter({ hasText: "String quartet" }).getByLabel("Phone (optional)").fill("438 555 0100");
    await expect(card.getByText("All changes saved")).toBeVisible();
    await card.getByRole("button", { name: 'Remove "Lumière Photo"' }).click();
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openPlanSection(client, "contacts_vendors");
    await expect(again.getByTestId("entry-row")).toHaveText([/Planner or coordinator: Sasha Roy/, /Photographer: Lumière Photo/, /Live musician: String quartet/]);
    expect((await answers(eventId, "contacts_vendors"))!.vendors!.map((v) => `${v.role}|${v.name ?? ""}|${v.business ?? ""}|${v.phone ?? ""}|${v.email ?? ""}`)).toEqual([
      "planner|Sasha Roy||514 555 0123|", "photographer||Lumière Photo||hello@lumiere.test", "musician|String quartet||438 555 0100|",
    ]);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("a referenced contact who leaves the event is shown as unavailable and leaves the day-of contact open", async () => {
    await must(admin.from("clients").update({ archived_at: new Date().toISOString() }).eq("id", secondId));
    await client.reload();
    const card = await openPlanSection(client, "contacts_vendors");
    await expect(card).toContainText("That contact isn't on this event any more. Choose another contact or enter someone.");
    await expect(card.getByLabel("Contact", { exact: true })).toHaveValue(secondId);
    await expect(contactsStatus(client)).toContainText("still needed");
    await must(admin.from("clients").update({ archived_at: null }).eq("id", secondId));
    await client.reload();
    await expect(contactsStatus(client)).toContainText("Complete");
  });

  test("DJ expectations read the announcement language from Event basics; discuss stays open", async () => {
    const card = await openPlanSection(client, "dj_preferences");
    await expect(card.getByTestId("language-from-basics")).toContainText("Not set yet: choose it in Event basics.");
    await card.getByLabel("Interactive: get the crowd going").check();
    await card.getByLabel("Clean versions only").check();
    await card.getByLabel(`Not sure yet, discuss with ${tenant.displayName}`).last().check();
    await card.getByLabel("Desired atmosphere and what matters most (optional)").fill("Elegant dinner, then a packed dance floor");
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("2 of 4 needed answers");
    await expect(card).toContainText(`Discuss with ${tenant.displayName} (still open)`);

    // Another section's answer reaches this one (it stays mounted while hidden).
    const basics = await openPlanSection(client, "basics");
    await basics.getByLabel("Language for announcements (optional)").selectOption({ label: "Bilingual (French and English)" });
    await expect(basics.getByText("All changes saved")).toBeVisible();
    await openPlanSection(client, "dj_preferences");
    await expect(card.getByTestId("language-from-basics")).toContainText("Bilingual (French and English), from Event basics.");
    await expect(card).toContainText("3 of 4 needed answers");
    await card.getByLabel("Guests may request songs (never anything on Do not play)").check();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("DJ expectations and overall preferences is complete.");
    expect(await answers(eventId, "dj_preferences")).toEqual({ interaction: "interactive", lyrics: "clean", requests: "welcome", atmosphere: "Elegant dinner, then a packed dance floor" });
  });

  test("music preferences: styles or DJ's choice and slow songs; typing during saves, failed saves and stale tabs keep answers", async () => {
    const card = await openPlanMoment(client, "party", "music_preferences");
    const stage = client.getByTestId("stage-party");
    await card.getByLabel("Pop", { exact: true }).check();
    await card.getByLabel("Rock", { exact: true }).check();
    await card.getByLabel("Other style (optional)").fill("Afrobeats");
    await expect(card.getByLabel(/choice/).first()).toBeDisabled();
    await card.getByLabel("A few", { exact: true }).check();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(stage.getByTestId("moment-music_preferences").locator("summary").first()).toContainText("Complete");

    let release = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await card.getByLabel("Disco and funk").check();
    await expect(card.getByText("Saving…")).toBeVisible();
    await card.getByLabel("Favourite artists (optional)").fill("Daft Punk, Beyoncé");
    release();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await client.unroute(`**${planningUrl}*`);
    await expect.poll(async () => await answers(eventId, "music_preferences")).toEqual({
      genres: ["pop", "rock", "disco_funk"], other_style: "Afrobeats", slow_songs: "a_few", favorite_artists: "Daft Punk, Beyoncé",
    });

    await client.route(`**${planningUrl}*`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await card.getByLabel("Dance-floor atmosphere (optional)").fill("Peak late");
    await expect(card.getByRole("alert")).toContainText("Couldn't save. Check your connection and retry.");
    await expect(card.getByLabel("Dance-floor atmosphere (optional)")).toHaveValue("Peak late");
    await client.unroute(`**${planningUrl}*`);
    await card.getByRole("button", { name: "Retry saving" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();

    const other = await clientContext.newPage();
    await other.goto(planningUrl);
    const otherCard = await openPlanMoment(other, "party", "music_preferences");
    await card.getByLabel("Latin", { exact: true }).check();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await otherCard.getByLabel("Country", { exact: true }).check();
    await expect(otherCard.getByRole("alert")).toContainText("changed in another tab or window");
    expect((await answers(eventId, "music_preferences"))!.genres).toEqual(["pop", "rock", "disco_funk", "latin"]);
    await other.close();
  });

  test("staff on a phone see and edit the same answers; hiding keeps them; nothing contractual changes", async () => {
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByTestId("staff-plan-overview")).toBeVisible();
    const card = await openPlanSection(staff, "contacts_vendors");
    await card.getByRole("button", { name: 'Edit "Sasha Roy"' }).click();
    await card.getByTestId("entry-row").filter({ hasText: "Sasha Roy" }).getByLabel("Coordination notes (optional, shared with you and the DJ)").fill("Cue the DJ for the entrance and the cake");
    await expect(card.getByText("All changes saved")).toBeVisible();
    expect((await answers(eventId, "contacts_vendors"))!.vendors![0].notes).toBe("Cue the DJ for the entrance and the cake");
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);

    await openPlanSection(staff, "plan-structure");
    await staff.getByRole("button", { name: "Hide Contacts and vendors from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Contacts and vendors", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("section-contacts_vendors")).toHaveCount(0);
    expect((await answers(eventId, "contacts_vendors"))!.vendors).toHaveLength(3);
    await staff.getByRole("button", { name: "Restore Contacts and vendors", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Contacts and vendors from the client", exact: true })).toBeVisible();
    await client.reload();
    const back = await openPlanSection(client, "contacts_vendors");
    await expect(back.getByTestId("entry-row")).toHaveCount(3);
    await expect(client.locator("body")).not.toContainText("E2E INTERNAL NOTE");
    await expect(client.locator("body")).not.toContainText("E2E-PAYMENT-REF-SECRET");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    expect(await contractualState(eventId)).toBe(contractual);
  });
});
