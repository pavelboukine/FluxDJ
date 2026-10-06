/**
 * The remaining planning editors in a real browser against local Supabase,
 * inside a dedicated test tenant with a booked wedding (booking set up
 * through the database functions the app calls; see booking.ts), to which
 * staff added the library's Guest arrival and Speeches and program stages.
 * Everything about these editors goes through the UI:
 *   - Arrival details reuse the Ceremony's place and guest-arrival time
 *     explicitly, or take their own times with an explicit next day;
 *   - Program details: overall host and an agenda with times and cues;
 *   - Dinner and Party activities (shared editor) with songs on the entry;
 *   - Dedications stay open until each has a song and a timing;
 *   - pending, failed and stale saves keep entries; undo after remove;
 *   - staff edit on a phone; hiding keeps answers; archived plans are
 *     read-only; nothing contractual changes.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-remaining-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Opens a stage card and one of its moment cards (unless already open); returns the moment's card. */
async function openMoment(root: Page | Locator, stageKey: string, momentKey: string): Promise<Locator> {
  const stage = root.getByTestId(new RegExp(`^(staff-)?stage-${stageKey}$`));
  const moment = stage.getByTestId(`moment-${momentKey}`);
  for (const card of [stage, moment]) {
    if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) await card.locator("summary").first().click();
  }
  return moment;
}

async function addEntry(card: Locator, testId: string, fill: (form: Locator) => Promise<void>) {
  const form = card.getByTestId(testId);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  await fill(form);
  await form.getByRole("button", { name: "Add", exact: true }).click();
}

async function answers(eventId: string, key: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return ((await admin.from("event_plan_responses").select("answers").eq("item_id", item.id).maybeSingle()).data?.answers ?? null) as
    (Record<string, unknown> & { entries?: Record<string, unknown>[] }) | null;
}

test.describe.serial("remaining planning editors", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractual = "";
  let planningUrl = "";
  let staffPlanningUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("remaining", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E Remaining Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14", venue_name: "Château E2E",
      internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    // The library's Guest arrival and Speeches and program stages (the structure editor is covered by planning-flow.spec.ts).
    const version = async () => (await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single())).data!.structure_version;
    for (const [key, parent] of [["arrival", null], ["arrival_details", "arrival"], ["program", null], ["program_details", "program"]] as const) {
      await must(staffDb.rpc("add_event_plan_item", { p_event_id: eventId, p_expected_version: await version(), p_key: key, p_parent_key: parent }));
    }
    await bookEvent(tenant, eventId, clientEmail);
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const ceremony = plan!.event_plan_items.find((i) => i.key === "ceremony")!.id;
    await must(staffDb.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: ceremony, p_expected_revision: 0,
      p_answers: { location_source: "other", location_other: "Chapel Sainte-Anne", guest_arrival_time: "15:30", start_time: "16:00" } }));
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

  test("arrival reuses the ceremony's place and arrival time explicitly, or takes its own times with next day", async () => {
    const card = await openMoment(client, "arrival", "arrival_details");
    await card.getByLabel(/Same as the ceremony \(Chapel Sainte-Anne\)/).check();
    await card.getByLabel(/Same as the ceremony's guest arrival \(15:30\)/).check();
    await card.getByLabel("Welcome instructions (optional)").fill("Drinks on the terrace");
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-arrival_details").locator("summary").first()).toContainText("Complete");
    expect(await answers(eventId, "arrival_details")).toEqual({ location_source: "ceremony", time_source: "ceremony", welcome: "Drinks on the terrace" });

    await card.getByLabel("At a specific time").check();
    await card.getByLabel("Arrival starts (needed)").fill("23:30");
    await card.getByLabel("Arrival ends (optional)").fill("00:15");
    await expect(card.getByText('The end must be after the start. If it ends after midnight, check "Next day".')).toBeVisible();
    await card.getByRole("checkbox", { name: /Arrival ends: next day/ }).check();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await card.getByLabel("No separate arrival arrangements").check();
    await expect(card.getByText('Clear the location and times first, or uncheck "No separate arrival arrangements".')).toBeVisible();
    await card.getByLabel("No separate arrival arrangements").uncheck();
    await expect(card.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openMoment(client, "arrival", "arrival_details");
    await expect(again.getByLabel("Arrival ends (optional)")).toHaveValue("00:15");
    expect(await answers(eventId, "arrival_details")).toEqual({
      location_source: "ceremony", time_source: "time", start_time: "23:30", end_time: "00:15", end_next_day: true, welcome: "Drinks on the terrace",
    });
  });

  test("program details: host and an agenda with an exact time and a cue; undecided stays open; reorder and undo", async () => {
    const card = await openMoment(client, "program", "program_details");
    await card.getByLabel("Host (optional)").fill("Kiara Okafor");
    await card.getByLabel("Host pronunciation guide (optional)").fill("kee-AR-ah");
    await addEntry(card, "program_details-entries-add", async (form) => {
      await form.getByLabel("Title").fill("Welcome");
      await form.getByLabel("At an exact time").check();
      await form.getByLabel("Time", { exact: true }).fill("19:00");
      await form.getByLabel("Presenter (optional)").fill("Kiara");
    });
    await addEntry(card, "program_details-entries-add", async (form) => {
      await form.getByLabel("Title").fill("Slideshow");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("An entry has no time or moment yet");
    await card.getByRole("button", { name: 'Edit "Slideshow"' }).click();
    const slideshow = card.getByTestId("entry-row").filter({ hasText: "Slideshow" });
    await slideshow.getByLabel("At a moment in the evening").check();
    await slideshow.getByLabel("Moment", { exact: true }).fill("After the main course");
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("Program details is complete.");
    await card.getByRole("button", { name: 'Move "Slideshow" up' }).click();
    await card.getByRole("button", { name: 'Remove "Welcome"' }).click();
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await client.reload();
    const again = await openMoment(client, "program", "program_details");
    await expect(again.getByTestId("entry-row")).toHaveText([/1\. Slideshow.*After the main course/, /2\. Welcome.*At 19:00/]);
    expect((await answers(eventId, "program_details"))!.host_pronunciation).toBe("kee-AR-ah");
  });

  test("activities: Dinner and Party share the editor, songs live on the entry, and alternatives are explicit", async () => {
    const dinner = await openMoment(client, "dinner", "dinner_activities");
    await addEntry(dinner, "dinner_activities-entries-add", async (form) => {
      await form.getByLabel("Activity").fill("Shoe game");
      await form.getByLabel("At a moment in the evening").check();
      await form.getByLabel("Moment", { exact: true }).fill("Between courses");
      await form.getByLabel("Song title").fill("Shoe");
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form).toContainText("Enter the song's title and artist, or clear the song.");
      await form.getByLabel("Song artist").fill("The Band");
    });
    await addEntry(dinner, "dinner_activities-entries-add", async (form) => {
      await form.getByLabel("Activity").fill("Lantern blessing (family tradition)");
      await form.getByLabel("At an exact time").check();
      await form.getByLabel("Time", { exact: true }).fill("20:45");
      await form.getByLabel("Pronunciation guide (optional)").fill("LAN-tern");
    });
    await expect(dinner.getByText("All changes saved")).toBeVisible();
    await expect(dinner.getByTestId("entry-row").nth(0)).toContainText("Song: Shoe by The Band");
    await expect(client.getByTestId("moment-dinner_activities").locator("summary").first()).toContainText("Complete");

    const party = await openMoment(client, "party", "party_activities");
    await party.getByLabel("No activities").check();
    await expect(party.getByText("All changes saved")).toBeVisible();
    await expect(party).toContainText("Not needed (you said so)");
    expect(await answers(eventId, "party_activities")).toEqual({ choice: "none" });
    expect((await answers(eventId, "dinner_activities"))!.entries!.map((e) => `${e.name}|${e.timing}|${e.cue ?? e.time}`)).toEqual([
      "Shoe game|cue|Between courses", "Lantern blessing (family tradition)|time|20:45",
    ]);
  });

  test("dedications stay open until each has a song and a timing; pending, failed and stale saves keep them", async () => {
    const card = await openMoment(client, "party", "dedications");
    await addEntry(card, "dedications-entries-add", async (form) => {
      await form.getByLabel("For whom").fill("Our grandparents");
      await form.getByLabel("Announcement message (optional)").fill("For 60 years together");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("A dedication still needs a song or timing");
    await expect(card.getByTestId("entry-row").first()).toContainText("Song not chosen yet");
    expect((await answers(eventId, "dedications"))!.entries![0]).toEqual(expect.not.objectContaining({ song_title: expect.anything() }));

    // Typing during a pending save survives it.
    let release = () => {};
    let held = false;
    await client.route(`**${planningUrl}`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await card.getByRole("button", { name: 'Edit "Our grandparents"' }).click();
    const row = card.getByTestId("entry-row").filter({ hasText: "Our grandparents" });
    await row.getByLabel("Relationship (optional)").fill("Grandparents");
    await expect(card.getByText("Saving…")).toBeVisible();
    // A song needs both fields: typed during the save, it is sent next.
    await row.getByLabel("Song title").fill("Moon River");
    await row.getByLabel("Song artist").fill("Andy Williams");
    release();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await client.unroute(`**${planningUrl}`);
    await expect.poll(async () => (await answers(eventId, "dedications"))!.entries![0]).toMatchObject({ song_title: "Moon River", song_artist: "Andy Williams", timing: "anytime" });
    await expect(card).toContainText("Dedications is complete.");

    // A failed save keeps the edit and retries.
    await client.route(`**${planningUrl}`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await row.getByLabel("At an exact time").check();
    await row.getByLabel("Time", { exact: true }).fill("00:30");
    await expect(card.getByRole("alert")).toContainText("Couldn't save. Check your connection and retry.");
    await row.getByRole("checkbox", { name: /next day/ }).check();
    await expect(row.getByRole("checkbox", { name: /next day/ })).toBeChecked();
    await expect(card.getByRole("alert")).toContainText("Couldn't save.");
    await client.unroute(`**${planningUrl}`);
    await card.getByRole("button", { name: "Retry saving" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();
    expect((await answers(eventId, "dedications"))!.entries![0]).toMatchObject({ timing: "time", time: "00:30", next_day: true });

    // A stale tab gets a conflict and overwrites nothing.
    const other = await clientContext.newPage();
    await other.goto(planningUrl);
    const otherCard = await openMoment(other, "party", "dedications");
    await addEntry(card, "dedications-entries-add", async (form) => {
      await form.getByLabel("For whom").fill("Team Lee");
      await form.getByLabel("Song title").fill("Jump");
      await form.getByLabel("Song artist").fill("Van Halen");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await otherCard.getByRole("button", { name: 'Remove "Our grandparents"' }).click();
    await expect(otherCard.getByRole("alert")).toContainText("changed in another tab or window");
    expect((await answers(eventId, "dedications"))!.entries!.map((e) => e.recipient)).toEqual(["Our grandparents", "Team Lee"]);
    await other.close();
  });

  test("staff on a phone edit the same entries; hiding keeps them; archived plans are read-only; nothing contractual changes", async () => {
    await staff.goto(staffPlanningUrl);
    const program = await openMoment(staff.locator("main"), "program", "program_details");
    await program.getByRole("button", { name: 'Edit "Welcome"' }).click();
    await program.getByTestId("entry-row").filter({ hasText: "Welcome" }).getByLabel("Instructions (optional)").fill("Mic on the stand");
    await expect(program.getByText("All changes saved")).toBeVisible();
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);

    await staff.getByRole("button", { name: "Hide Speeches and program from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Speeches and program", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("stage-program")).toHaveCount(0);
    expect((await answers(eventId, "program_details"))!.entries).toHaveLength(2);
    await staff.getByRole("button", { name: "Restore Speeches and program", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Speeches and program from the client", exact: true })).toBeVisible();

    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", eventId));
    await staff.reload();
    const archived = await openMoment(staff.locator("main"), "party", "dedications");
    await expect(archived).toContainText("Unarchive the event to edit planning.");
    await expect(archived.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    await must(admin.from("events").update({ archived_at: null }).eq("id", eventId));

    await client.reload();
    for (const [stage, moment] of [["arrival", "arrival_details"], ["program", "program_details"], ["dinner", "dinner_activities"], ["party", "dedications"]]) await openMoment(client, stage, moment);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    await expect(client.locator("body")).not.toContainText("E2E INTERNAL NOTE");
    expect(await contractualState(eventId)).toBe(contractual);
  });
});
