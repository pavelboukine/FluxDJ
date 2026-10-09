/**
 * Planning in a real browser against local Supabase, in a dedicated test
 * tenant. The booking itself (proposal, approval, contract, signature,
 * deposit) is set up through the same database functions the app calls
 * (their screens are covered by the proposal, contract and payment specs);
 * everything about planning goes through the UI:
 *   - booking without a chosen template gives a Basics-only plan and staff
 *     are prompted to configure it;
 *   - starter templates are added explicitly and idempotently; templates are
 *     renamed, reordered, trimmed and duplicated with stable keys;
 *   - the client (phone-sized) opens planning from /my, sees imported answers
 *     read-only and fills Event basics with autosave: edits typed during a
 *     save survive, a failed save keeps input and retries, a stale tab gets a
 *     conflict;
 *   - staff apply a template without losing answers, hide and restore a stage,
 *     and template edits don't reach the plan;
 *   - archiving closes client planning; unarchiving reopens it.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";
import { admin, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-plan-${run}@example.test`;
const title = `E2E Plan Wedding ${run}`;
/** A returning client signs in; with no staff role, they land on /my (the login form is covered by contract-send-flow.spec.ts). */
async function signInClient(page: Page, email: string) {
  await signInWithLink(page, email);
  await page.waitForURL("**/my");
}

let contractual = "";
const stageRow = async (eventId: string, key: string) => {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return (await admin.from("event_plan_responses").select("answers, revision, updated_by_actor").eq("item_id", item.id).maybeSingle()).data;
};
/** The stage names as the section list shows them (whether or not the phone's picker is open). */
const stageNav = (page: Page) =>
  page.getByTestId("section-picker").getByRole("list", { name: "Stages of the event, in order", includeHidden: true }).locator(":scope > li");
const sectionParam = (page: Page) => new URL(page.url()).searchParams.get("section");
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const basicsRow = async (eventId: string) => {
  const { data } = await admin.from("event_plans").select("id, event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === "basics")!;
  return (await admin.from("event_plan_responses").select("answers, revision, updated_by_actor").eq("item_id", item.id).maybeSingle()).data;
};

test.describe.serial("planning", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractId = "";
  let planningUrl = "";
  let staffPlanningUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("plan", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-08-14",
      venue_name: "Château E2E", venue_address: "1 Rue du Lac, Gatineau", internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    // Sign in first: Auth refuses a sign-in email within a second of the setup's own magic-link token for the same address.
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    contractId = await bookEvent(tenant, eventId, clientEmail);
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("booking without a template creates Event basics only, and staff are prompted to configure it", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const card = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Planning", { exact: true }) });
    await expect(card).toContainText("Event basics only: choose a template to add the event's stages.");
    await card.getByRole("link", { name: "Edit planning" }).click();
    await staff.waitForURL(`**${staffPlanningUrl}`);
    await expect(staff.getByText("Created with Event basics only, because no template was chosen. Set up when the event was booked.")).toBeVisible();
    await expect(staff.getByText("Choose a template below to add this event's stages and moments")).toBeVisible();
    await expect(staff.getByTestId("client-access")).toContainText("The event is booked: the client");
    // Frozen proposal answers, separate from planning fields.
    const frozen = staff.locator("[data-slot=card]").filter({ has: staff.getByText("From the signed contract (frozen)") });
    await expect(frozen).toContainText("DEMO: Where will the ceremony take place?");
    await expect(frozen).toContainText("Same room as the reception");
    await expect(staff.getByRole("link", { name: "Manage planning templates" })).toBeVisible();
  });

  test("starter templates are added explicitly and once; staff rename, reorder, trim and duplicate with stable keys", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates`);
    await expect(staff.getByText("No planning templates yet.")).toBeVisible();
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    await expect(staff.getByText("Added Wedding and Simple Party.")).toBeVisible();
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    await expect(staff.getByText("The starter templates are already here")).toBeVisible();
    expect((await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id)).data).toHaveLength(2);

    await staff.getByRole("link", { name: "Wedding", exact: true }).click();
    await staff.waitForURL(/planning-templates\/[0-9a-f-]{36}$/);
    const templateId = staff.url().split("/").pop()!;
    const stageKeys = async () =>
      ((await admin.from("planning_template_items").select("key, position").eq("template_id", templateId).eq("kind", "stage").order("position")).data ?? []).map((r) => r.key);

    await staff.getByLabel("Label for Party", { exact: true }).fill("Dance party");
    await staff.getByRole("button", { name: "Rename Party", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Dance party", exact: true })).toBeVisible();
    const { data: party } = await admin.from("planning_template_items").select("key, label").eq("template_id", templateId).eq("label", "Dance party").single();
    expect(party!.key).toBe("party");

    await expect(staff.getByRole("button", { name: "Move Ceremony up", exact: true })).toBeDisabled();
    await staff.getByRole("button", { name: "Move Cocktail up", exact: true }).click();
    await expect.poll(stageKeys).toEqual(["cocktail", "ceremony", "reception_entrance", "dinner", "special_dances", "party", "closing"]);
    // The database commits before the browser gets the action's response (with the new template
    // version). Wait for the re-rendered order before the next move, or it is sent with the old
    // version and correctly refused as a concurrent change. The signal must come from the
    // refreshed page: a pending move only disables its own button, so "Move Ceremony up"
    // becomes enabled only once Ceremony is rendered second.
    await expect(staff.getByRole("button", { name: "Move Ceremony up", exact: true })).toBeEnabled();
    await staff.getByRole("button", { name: "Move Cocktail down", exact: true }).click();
    await expect.poll(stageKeys).toEqual(["ceremony", "cocktail", "reception_entrance", "dinner", "special_dances", "party", "closing"]);
    await expect(staff.getByRole("button", { name: "Move Cocktail up", exact: true })).toBeEnabled();

    staff.once("dialog", (d) => void d.accept());
    await staff.getByRole("button", { name: "Remove Dedications", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Remove Dedications", exact: true })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Remove Event basics", exact: true })).toHaveCount(0);

    // A stale tab gets a conflict instead of overwriting.
    const stale = await staffContext.newPage();
    await stale.goto(staff.url());
    await staff.getByLabel("Label for Closing", { exact: true }).fill("Last dance");
    await staff.getByRole("button", { name: "Rename Closing", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Last dance", exact: true })).toBeVisible();
    await stale.getByLabel("Label for Cocktail", { exact: true }).fill("Cocktail hour");
    await stale.getByRole("button", { name: "Rename Cocktail", exact: true }).click();
    await expect(stale.locator("main").getByRole("alert")).toContainText("Someone else saved changes first");
    await expect(stale.getByLabel("Label for Cocktail", { exact: true })).toHaveValue("Cocktail hour");
    await stale.close();

    await staff.getByLabel("Name of the copy").fill("Wedding (French)");
    await staff.getByRole("button", { name: "Duplicate" }).click();
    await staff.waitForURL((url) => !url.pathname.endsWith(templateId));
    await expect(staff.getByRole("heading", { name: "Wedding (French)" })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Rename Dance party", exact: true })).toBeVisible();
  });

  test("the client opens planning from /my on a phone, sees imported answers read-only and fills Event basics", async () => {
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInClient(client, clientEmail);
    await client.getByRole("link", { name: `Plan your event for ${title}` }).click();
    await client.waitForURL(`**${planningUrl}*`);
    // The overview: event, deadline state, honest progress and one obvious next step.
    await expect(client.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(client.getByRole("link", { name: "Your events" })).toHaveAttribute("href", "/my");
    await expect(client.getByTestId("editing-chip")).toHaveText("Planning open");
    await expect(client.getByTestId("editing-notice")).toContainText("(America/Toronto)");
    await expect(client.getByTestId("progress-headline")).toHaveText("1 of 5 required answers");
    await expect(client.getByText("Progress covers the 1 section you can fill in now (Event basics).")).toBeVisible();
    await expect(client.getByText("it doesn't mean", { exact: false })).toContainText("reviewed or approved your plan");
    // A plan without stages is small: no stage list at all.
    await expect(stageNav(client)).toHaveCount(0);
    // Imported proposal answers have their own place, read-only.
    await client.getByRole("link", { name: "See what you already provided" }).click();
    expect(sectionParam(client)).toBe("already-provided");
    const provided = client.getByRole("region", { name: "Already provided" });
    await expect(provided).toContainText("DEMO: Will there be speeches that need a wireless microphone?");
    await expect(provided).toContainText("No");
    await expect(provided.getByRole("textbox")).toHaveCount(0);
    await openPlanSection(client, null);
    await client.getByTestId("plan-primary").click();
    expect(sectionParam(client)).toBe("basics");
    await expect(client.locator("#plan-heading-basics")).toBeFocused();
    await expect(client.getByText("Château E2E, 1 Rue du Lac, Gatineau")).toBeVisible();
    await expect(client.getByText(`Provided by ${tenant.displayName}. Contact them if it changes.`)).toBeVisible();

    await client.getByLabel("Guest count (needed)").fill("150");
    await client.getByLabel("Start time (needed)").fill("18:00");
    await client.getByLabel("End time (needed)").fill("01:00");
    await expect(client.getByText("Ends after midnight, the next day.")).toBeVisible();
    await client.getByLabel("No special instructions").check();
    await expect(client.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("progress-headline")).toHaveText("Available sections done");
    await expect(client.getByText("Event basics is complete.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toEqual({ guest_count: 150, start_time: "18:00", end_time: "01:00", access_notes_none: true });

    // A refresh keeps the open section.
    await client.reload();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
    await expect(client.getByLabel("No special instructions")).toBeChecked();
    // Every available answer is in: the overview offers a review, not "continue".
    await openPlanSection(client, null);
    await expect(client.getByTestId("plan-primary")).toHaveText("Review your plan");
    await openPlanSection(client, "basics");
    await expect(client.locator("body")).not.toContainText(/E2E INTERNAL NOTE|E2E-PAYMENT-REF-SECRET|E2E staff payment note|Planning complete/);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);

    // Invalid input stays on screen and is never sent.
    await client.getByLabel("Guest count (needed)").fill("lots");
    await expect(client.getByText("Enter a guest count between 1 and 5,000.")).toBeVisible();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("lots");
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 150 });
    await client.getByLabel("Guest count (needed)").fill("150");
    await expect(client.getByText("All changes saved")).toBeVisible();
  });

  test("edits typed while a save is pending survive; a failed save keeps input and retries; a stale tab gets a conflict", async () => {
    let release: () => void = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await client.getByLabel("Guest count (needed)").fill("160");
    await expect(client.locator("#plan-panel-basics").getByText("Saving…")).toBeVisible();
    await client.getByLabel("Room or space within the venue (optional)").fill("Grand hall");
    release();
    await expect(client.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 160, venue_room: "Grand hall" });
    await client.unroute(`**${planningUrl}*`);

    await client.route(`**${planningUrl}*`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await client.getByLabel("Guest count (needed)").fill("170");
    await expect(client.locator("main").getByRole("alert")).toContainText("Couldn't save. Check your connection and retry. Your answers are still here.");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("170");
    await client.unroute(`**${planningUrl}*`);
    await client.getByRole("button", { name: "Retry saving" }).click();
    await expect(client.getByText("All changes saved")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 170 });

    const other = await clientContext.newPage();
    await other.goto(`${planningUrl}?section=basics`);
    await client.getByLabel("Guest count (needed)").fill("175");
    await expect(client.getByText("All changes saved")).toBeVisible();
    await other.getByLabel("Room or space within the venue (optional)").fill("Terrace");
    await expect(other.locator("main").getByRole("alert")).toContainText("changed in another tab or window");
    await expect(other.getByLabel("Room or space within the venue (optional)")).toHaveValue("Terrace");
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175, venue_room: "Grand hall" });
    await other.close();
  });

  test("staff apply a template without losing answers; the client sees the stages in order", async () => {
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByText("Last saved by the client.")).toBeVisible();
    await expect(staff.getByLabel("Guest count (needed)")).toHaveValue("175");
    const apply = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Replace the structure with a template") });
    await apply.getByLabel("Template").selectOption({ label: "Wedding" });
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByRole("alert")).toContainText("Check the box to confirm replacing the structure.");
    await apply.getByLabel(/I understand this replaces/).check();
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByText("Template applied: 1 kept, 37 added, 0 hidden. No answers were removed.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175, venue_room: "Grand hall" });

    await client.reload();
    await expect(stageNav(client)).toHaveText([
      /1\. Ceremony/, /2\. Cocktail/, /3\. Reception entrance/, /4\. Dinner/, /5\. Special dances/, /6\. Dance party/, /7\. Last dance/,
    ]);
    const ceremony = await openPlanSection(client, "ceremony");
    await expect(ceremony).toContainText("Processional participants");
    // Every moment has an editor now: nothing says it isn't open yet.
    await expect(client.getByText(/Not open for planning yet|Not available yet/)).toHaveCount(0);
    await expect(client.getByTestId("section-picker").getByTestId("nav-contacts_vendors")).toContainText("Not started");
    // Event basics (5 of 5), the six stage editors' 12 requirements, the 17 song moments, who walks in, MC,
    // introductions and speeches, contacts (2), preferences (4), music styles (2), and the activities and dedications this
    // trimmed template kept (2), none answered yet.
    await expect(client.getByTestId("progress-headline")).toHaveText("5 of 48 required answers");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    // Continue planning opens the first section, in plan order, with answers still needed.
    await openPlanSection(client, null);
    await expect(client.getByText(/Progress covers the \d+ sections you can fill in now\./)).toBeVisible();
    await expect(client.getByTestId("plan-primary")).toHaveText("Continue planning");
    await client.getByTestId("plan-primary").click();
    expect(sectionParam(client)).toBe("contacts_vendors");
    await expect(client.locator("#plan-panel-contacts_vendors")).toBeVisible();
  });

  test("the client fills ceremony details on a phone: venue reuse, discuss with DJ, completion and a persisted reload", async () => {
    const card = await openPlanSection(client, "ceremony");
    const details = card.getByTestId("details-ceremony");
    const status = card.getByTestId("details-status");
    await expect(status).toContainText("Not started");
    await details.getByLabel("Same as the event venue (Château E2E, 1 Rue du Lac, Gatineau)").check();
    await details.getByLabel("Ceremony start (needed)").fill("16:00");
    await details.getByLabel("Not sure, discuss with DJ").check();
    await expect(details.getByText("All changes saved")).toBeVisible();
    await expect(details.getByRole("list", { name: "What Ceremony details needs" })).toContainText(`Discuss with ${tenant.displayName} (still open)`);
    await expect(status).toContainText("In progress");
    // Discuss with DJ is open, never complete; the section and the list both say so.
    await expect(card.getByTestId("section-status")).toContainText("1 to discuss");
    await expect(client.getByTestId("section-picker").getByTestId("nav-ceremony")).toContainText("1 to discuss");
    await expect(details.getByText("Equipment answers are planning information for your DJ to review.", { exact: false })).toBeVisible();
    // Optional fields don't block completion.
    await details.getByLabel("Needed", { exact: true }).check();
    await expect(details.getByText("Ceremony details is complete.")).toBeVisible();
    await expect(status).toContainText("Complete");
    expect((await stageRow(eventId, "ceremony"))!.answers).toEqual({ location_source: "event_venue", start_time: "16:00", microphones: "needed" });

    // A refresh reopens the same section, with the saved answers.
    await client.reload();
    await expect(client.locator("#plan-panel-ceremony")).toBeVisible();
    const again = client.getByTestId("details-ceremony");
    await expect(again.getByLabel("Ceremony start (needed)")).toHaveValue("16:00");
    await expect(again.getByLabel("Needed", { exact: true })).toBeChecked();
    await expect(again.getByLabel(/Same as the event venue/)).toBeChecked();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("overnight times need an explicit next day; timing conflicts are flagged without reordering the stages", async () => {
    const party = await openPlanSection(client, "party");
    const details = party.getByTestId("details-party");
    await details.getByLabel(/Same as the event venue/).check();
    await details.getByLabel("Party start (needed)").fill("22:00");
    await details.getByLabel("Party end (optional)").fill("01:00");
    await expect(details.getByText('The end must be after the start. If it ends after midnight, check "Next day".')).toBeVisible();
    await expect(details.getByRole("alert")).toContainText("Fix the highlighted answer to save.");
    expect(await stageRow(eventId, "party")).toBeNull();
    await details.getByLabel("Party end: next day (Sun, Aug 15)").check();
    await expect(details.getByText("All changes saved")).toBeVisible();
    expect((await stageRow(eventId, "party"))!.answers).toMatchObject({ start_time: "22:00", end_time: "01:00", end_next_day: true });

    const ceremony = client.getByTestId("details-ceremony");
    await openPlanSection(client, "ceremony");
    await ceremony.getByLabel("Ceremony end (optional)").fill("17:00");
    await expect(ceremony.getByText("All changes saved")).toBeVisible();
    const cocktailCard = await openPlanSection(client, "cocktail");
    const cocktail = cocktailCard.getByTestId("details-cocktail");
    await cocktail.getByLabel(/Same as the event venue/).check();
    await cocktail.getByLabel("Cocktail start (needed)").fill("16:30");
    await expect(cocktail.getByRole("status", { name: "Timing notes" })).toHaveText("Cocktail starts before Ceremony ends.");
    // A warning, not an error: it saved, and the stages keep their order.
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect(cocktailCard.getByTestId("section-status")).toContainText("Check timing");
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).toContainText("Check timing");
    await expect(client.getByTestId("plan-open")).toContainText("Check timing");
    await expect(stageNav(client)).toHaveText([
      /1\. Ceremony/, /2\. Cocktail/, /3\. Reception entrance/, /4\. Dinner/, /5\. Special dances/, /6\. Dance party/, /7\. Last dance/,
    ]);
    await cocktail.getByLabel("Cocktail start (needed)").fill("17:00");
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).not.toContainText("Check timing");
  });

  test("stage edits typed during a pending save survive; a failed save retries; a stale tab gets a conflict", async () => {
    const cocktail = client.getByTestId("details-cocktail");
    let release: () => void = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await cocktail.getByLabel("Cocktail end (optional)").fill("18:30");
    await expect(cocktail.getByText("Saving…")).toBeVisible();
    await cocktail.getByLabel("Atmosphere or music style (optional)").fill("Light jazz");
    release();
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ end_time: "18:30", atmosphere: "Light jazz" });
    await client.unroute(`**${planningUrl}*`);

    await client.route(`**${planningUrl}*`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await cocktail.getByLabel("Instructions for the DJ (optional)").fill("Keep it low during photos");
    await expect(cocktail.getByRole("alert")).toContainText("Couldn't save. Check your connection and retry.");
    await expect(cocktail.getByLabel("Instructions for the DJ (optional)")).toHaveValue("Keep it low during photos");
    await client.unroute(`**${planningUrl}*`);
    await cocktail.getByRole("button", { name: "Retry saving" }).click();
    await expect(cocktail.getByText("All changes saved")).toBeVisible();

    const other = await clientContext.newPage();
    await other.goto(`${planningUrl}?section=cocktail`);
    await cocktail.getByLabel("Cocktail end (optional)").fill("18:45");
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    const stale = other.getByTestId("details-cocktail");
    await stale.getByLabel("Atmosphere or music style (optional)").fill("Acoustic covers");
    await expect(stale.getByRole("alert")).toContainText("changed in another tab or window");
    await expect(stale.getByLabel("Atmosphere or music style (optional)")).toHaveValue("Acoustic covers");
    expect((await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ end_time: "18:45", atmosphere: "Light jazz" });
    await other.close();
  });

  test("switching sections never loses input: running saves finish, failed ones stay with Retry; Back, Forward and the keyboard work", async () => {
    const cocktail = await openPlanSection(client, "cocktail");
    const details = cocktail.getByTestId("details-cocktail");
    const atmosphere = details.getByLabel("Atmosphere or music style (optional)");
    const isAction = (route: { request(): { method(): string; headers(): Record<string, string> } }) =>
      route.request().method() === "POST" && Boolean(route.request().headers()["next-action"]);

    // A save still running when the client moves on (an incomplete section doesn't hold them back) finishes in the background.
    let release: () => void = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && isAction(route)) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await atmosphere.fill("Jazz trio");
    await expect(details.getByText("Saving…")).toBeVisible();
    await cocktail.getByRole("link", { name: /Next: Reception entrance/ }).click();
    expect(sectionParam(client)).toBe("reception_entrance");
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).toContainText("Saving…");
    release();
    await expect.poll(async () => (await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ atmosphere: "Jazz trio" });
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).not.toContainText("Saving…");
    await client.unroute(`**${planningUrl}*`);

    // Back returns to the section, input intact; typing then leaving at once still saves.
    await client.goBack();
    expect(sectionParam(client)).toBe("cocktail");
    await expect(atmosphere).toHaveValue("Jazz trio");
    await atmosphere.fill("Jazz trio, then funk");
    await openPlanSection(client, "dinner");
    await expect.poll(async () => (await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ atmosphere: "Jazz trio, then funk" });

    // A failed save in a section the client left is flagged everywhere, keeps the input and retries there.
    await client.route(`**${planningUrl}*`, (route) => (isAction(route) ? route.abort() : route.continue()));
    await client.goBack();
    expect(sectionParam(client)).toBe("cocktail");
    await atmosphere.fill("Swing");
    await expect(details.getByRole("alert")).toContainText("Couldn't save");
    await openPlanSection(client, "party");
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).toContainText("Not saved");
    const elsewhere = client.getByTestId("unsaved-elsewhere");
    await expect(elsewhere).toContainText("Some changes weren't saved");
    expect((await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ atmosphere: "Jazz trio, then funk" });
    await elsewhere.getByRole("link", { name: "Open Cocktail" }).click();
    expect(sectionParam(client)).toBe("cocktail");
    await expect(atmosphere).toHaveValue("Swing");
    await client.unroute(`**${planningUrl}*`);
    await details.getByRole("button", { name: "Retry saving" }).click();
    await expect(details.getByText("All changes saved")).toBeVisible();
    await expect(elsewhere).toHaveCount(0);
    expect((await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ atmosphere: "Swing" });

    // Back and Forward move between sections; nothing is saved by navigating.
    const before = await stageRow(eventId, "party");
    await client.goBack();
    expect(sectionParam(client)).toBe("party");
    await expect(client.locator("#plan-panel-party")).toBeVisible();
    await client.goForward();
    expect(sectionParam(client)).toBe("cocktail");
    await expect(atmosphere).toBeVisible();
    expect(await stageRow(eventId, "party")).toEqual(before);

    // The phone's section picker works from the keyboard, and focus lands on the new section's heading.
    const picker = client.getByTestId("section-picker");
    await picker.locator("summary").focus();
    await client.keyboard.press("Enter");
    await picker.getByTestId("nav-dinner").focus();
    await client.keyboard.press("Enter");
    expect(sectionParam(client)).toBe("dinner");
    await expect(client.locator("#plan-heading-dinner")).toBeFocused();
    await expect(picker).not.toHaveAttribute("open", "");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);

    // The smallest phones and landscape never scroll sideways, on a long stage or the overview.
    for (const size of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
      await client.setViewportSize(size);
      await openPlanSection(client, "reception_entrance");
      expect(await noSideways(client)).toBeLessThanOrEqual(0);
      await openPlanSection(client, null);
      expect(await noSideways(client)).toBeLessThanOrEqual(0);
    }
    await client.setViewportSize({ width: 390, height: 844 });
  });

  test("staff edit stage details reusing Event basics; hidden stages keep their answers; nothing contractual changes", async () => {
    await staff.goto(staffPlanningUrl);
    const card = staff.getByTestId("staff-stage-dinner");
    await card.locator("summary").first().click();
    const dinner = card.getByTestId("details-dinner");
    await dinner.getByLabel(/Same as the event venue/).check();
    await dinner.getByLabel("Dinner start (needed)").fill("19:30");
    await dinner.getByLabel("Same as the guest count in Event basics (175)").check();
    await expect(dinner.getByText("All changes saved")).toBeVisible();
    await expect(card.locator("summary").first()).toContainText("Complete");
    expect((await stageRow(eventId, "dinner"))).toMatchObject({ answers: { location_source: "event_venue", start_time: "19:30", guest_count_source: "basics" }, updated_by_actor: "staff" });
    // The reuse is stored as a choice, not a copied number.
    expect((await stageRow(eventId, "dinner"))!.answers).not.toHaveProperty("guest_count");
    await expect(staff.getByTestId("staff-stage-ceremony").locator("summary").first()).toContainText("Complete");

    await staff.getByRole("button", { name: "Hide Cocktail from the client", exact: true }).click();
    await expect(staff.getByTestId("staff-stage-cocktail")).toHaveCount(0);
    // The client is still on Cocktail: once hidden, the link safely falls back to the overview.
    await client.goto(`${planningUrl}?section=cocktail`);
    await expect(client.getByText("That section isn't part of your plan any more, so the overview is shown instead.")).toBeVisible();
    await expect(client.locator("#plan-panel-overview")).toBeVisible();
    await expect.poll(() => sectionParam(client)).toBeNull();
    await expect(client.getByTestId("stage-cocktail")).toHaveCount(0);
    await expect(client.getByTestId("section-picker").getByTestId("nav-cocktail")).toHaveCount(0);
    expect((await stageRow(eventId, "cocktail"))!.answers).toMatchObject({ atmosphere: "Swing" });
    await staff.getByRole("button", { name: "Restore Cocktail", exact: true }).click();
    await expect(staff.getByTestId("staff-stage-cocktail")).toBeVisible();
    await client.reload();
    await openPlanSection(client, "cocktail");
    await expect(client.getByTestId("details-cocktail").getByLabel("Atmosphere or music style (optional)")).toHaveValue("Swing");
    await openPlanSection(client, "dinner");
    await expect(client.getByTestId("details-dinner").getByLabel("Same as the guest count in Event basics (175)")).toBeChecked();
    await expect(client.locator("body")).not.toContainText(/E2E INTERNAL NOTE|E2E-PAYMENT-REF-SECRET|updated_by/);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    expect(await contractualState(eventId)).toBe(contractual);
  });

  test("hiding a stage hides it from the client and keeps its moments; restoring brings them back in order", async () => {
    await staff.goto(staffPlanningUrl);
    await staff.getByRole("button", { name: "Hide Dinner from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Dinner", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("stage-dinner")).toHaveCount(0);
    // Its moments go with it (the Party's activities hint still names cake cutting as having its own card).
    await expect(client.getByTestId("moment-cake_cutting")).toHaveCount(0);

    await staff.getByRole("button", { name: "Restore Dinner", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Dinner from the client", exact: true })).toBeVisible();
    await client.reload();
    const dinner = await openPlanSection(client, "dinner");
    // Timing is the stage's own details; the other moments follow in their configured order.
    await expect(dinner.getByRole("heading", { name: "Timing", exact: true })).toBeVisible();
    await expect(dinner.getByRole("list", { name: "Moments in Dinner" }).locator(":scope > li")).toHaveText([/Background music/, /Speeches and toasts/, /Activities/, /Cake cutting/]);
    await expect(dinner.getByTestId("details-dinner").getByLabel("Dinner start (needed)")).toHaveValue("19:30");

    // Template edits don't reach this event's plan.
    const { data: template } = await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding").single();
    await staff.goto(`/staff/${tenant.slug}/planning-templates/${template!.id}`);
    await staff.getByLabel("Label for Ceremony", { exact: true }).fill("Vows");
    await staff.getByRole("button", { name: "Rename Ceremony", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Vows", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("section-picker").getByTestId("nav-ceremony")).toContainText("Ceremony");

    // The staff planning page fits a phone too.
    const phone = await staffContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(staffPlanningUrl);
    await expect(phone.getByRole("heading", { name: `Planning: ${title}` })).toBeVisible();
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("the contract page links to planning; archiving closes client planning and unarchiving reopens it", async () => {
    await client.goto(`/${tenant.slug}/contracts/${contractId}`);
    await client.getByRole("link", { name: "Plan your event" }).click();
    await client.waitForURL(`**${planningUrl}*`);
    await openPlanSection(client, "basics");

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByRole("button", { name: "Archive…" }).click();
    await staff.getByRole("dialog", { name: "Confirm archiving" }).getByRole("button", { name: "Archive event" }).click();
    await expect(staff.getByRole("button", { name: "Unarchive event" })).toBeVisible();
    await client.getByLabel("Guest count (needed)").fill("180");
    await expect(client.locator("main").getByRole("alert")).toContainText("This section isn't available for editing any more");
    await client.reload();
    await expect(client.getByRole("heading", { name: "Planning isn't available" })).toBeVisible();
    await staff.goto(staffPlanningUrl);
    // Event basics, contacts, preferences, the six stage editors, the 17 song moments (Processional included), MC,
    // introductions, speeches, music styles and both activities (this trimmed template has no Dedications) are read-only
    // while archived.
    await expect(staff.getByText("Unarchive the event to edit planning.")).toHaveCount(32);
    await expect(staff.locator("#ceremony-start_time")).toBeDisabled();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175 });

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByRole("button", { name: "Unarchive event" }).click();
    await expect(staff.getByRole("button", { name: "Archive…" })).toBeVisible();
    await client.reload();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("175");

    // Another business's address for this event, and a suspended workspace: refused, revealing nothing.
    const other = await createTestTenant("plan-other");
    try {
      await client.goto(`/${other.slug}/planning/${eventId}?section=basics`);
      await expect(client.getByRole("heading", { name: "Planning isn't available" })).toBeVisible();
      await expect(client.locator("body")).not.toContainText(title);

      grantPlatformAdminLocally(other.ownerEmail);
      const operator = await sessionFor(other.ownerEmail);
      const version = async () => (await must(admin.from("tenants").select("suspension_version").eq("id", tenant.id).single())).data!.suspension_version as number;
      await must(operator.rpc("suspend_workspace", { p_tenant_id: tenant.id, p_expected_version: await version(), p_reason: "E2E planning check" }));
      try {
        await client.goto(`${planningUrl}?section=basics`);
        await expect(client.getByRole("heading", { name: "Planning isn't available" })).toBeVisible();
        await expect(client.locator("body")).not.toContainText(new RegExp(`${title}|suspend`, "i"));
      } finally {
        await must(operator.rpc("restore_workspace", { p_tenant_id: tenant.id, p_expected_version: await version(), p_reason: "E2E planning check done" }));
        revokePlatformAdminLocally(other.ownerEmail);
      }
      await client.reload();
      await expect(client.getByLabel("Guest count (needed)")).toHaveValue("175");
    } finally {
      await archiveTestTenant(other);
    }
    await clientContext.close();
  });
});
