/**
 * Planning in a real browser against local Supabase, in a dedicated test
 * tenant. The booking itself (proposal, approval, contract, signature,
 * deposit) is set up through the same database functions the app calls
 * (their screens are covered by the proposal, contract and payment specs);
 * everything about planning goes through the UI:
 *   - staff set planning up with Event basics only before the booking (the
 *     booking-without-a-template case is planning-setup-flow.spec.ts) and can
 *     still apply a template later;
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
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";
import { admin, openPlanMoment, openPlanSection, signInStaff, signInWithLink } from "./support";
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
    await must((await sessionFor(tenant.ownerEmail)).rpc("setup_event_plan", { p_event_id: eventId, p_template_id: null as unknown as string }));
    contractId = await bookEvent(tenant, eventId, clientEmail);
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("staff chose Event basics only before the booking: the plan is ready, and a template can still be applied", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const card = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Planning", { exact: true }) });
    await expect(card).toContainText("No template: this event's sections were chosen on the event.");
    await card.getByRole("link", { name: "Edit planning" }).click();
    await staff.waitForURL(`**${staffPlanningUrl}`);
    await expect(staff.getByText("Created with Event basics only, because no template was chosen. Set up by staff.")).toBeVisible();
    await expect(staff.getByText("To add a template's stages and moments, apply one in")).toBeVisible();
    await expect(staff.getByTestId("planning-setup")).toHaveCount(0);
    await expect(staff.getByTestId("client-access")).toContainText("The event is booked: the client");
    // Frozen proposal answers, separate from planning fields.
    const frozen = staff.locator("[data-slot=card]").filter({ has: staff.getByText("From the signed contract (frozen)") });
    await expect(frozen).toContainText("DEMO: Where will the ceremony take place?");
    await expect(frozen).toContainText("Same room as the reception");
    // Staff see the client's editing state up front, and the run sheet is one tap away.
    await expect(staff.getByTestId("client-editing-status")).toHaveText("Client editing open");
    await expect(staff.getByRole("link", { name: "Run sheet" })).toHaveAttribute("href", `/staff/${tenant.slug}/events/${eventId}/run-sheet`);
    await openPlanSection(staff, "plan-structure");
    await expect(staff.getByRole("link", { name: "Manage planning templates" })).toBeVisible();
  });

  test("starter templates are added explicitly and once; staff rename, reorder, trim, copy, create from an outline and preview with stable keys", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates`);
    await expect(staff.getByText("No planning templates yet.")).toBeVisible();
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    // Both starters are in the list, and the offer goes away (adding again is a no-op: pgTAP 25_planning).
    await expect(staff.getByTestId("planning-template-row")).toHaveCount(2);
    await expect(staff.getByTestId("starter-offer")).toHaveCount(0);
    expect((await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id)).data).toHaveLength(2);
    await expect(staff.getByTestId("planning-template-row").filter({ hasText: "Wedding" })).toContainText("3 general sections · 7 stages · 26 moments");

    await staff.getByRole("link", { name: "Wedding", exact: true }).click();
    await staff.waitForURL(/planning-templates\/[0-9a-f-]{36}$/);
    const templateId = staff.url().split("/").pop()!;
    const stageKeys = async () =>
      ((await admin.from("planning_template_items").select("key, position").eq("template_id", templateId).eq("kind", "stage").order("position")).data ?? []).map((r) => r.key);
    await expect(staff.getByTestId("future-events-note")).toContainText("Existing event plans won't change");
    // Every item says what it becomes for the client; Event basics says why it stays.
    await expect(staff.getByTestId("row-basics")).toContainText("Every plan has it, so it can't be removed.");
    await expect(staff.getByTestId("row-special_dances")).toContainText("The stage itself has no questions.");

    await staff.getByRole("button", { name: "Rename Party", exact: true }).click();
    await staff.getByLabel("Label for Party", { exact: true }).fill("Dance party");
    await staff.getByRole("button", { name: "Save the name of Party", exact: true }).click();
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

    // Moments open per stage; removing one offers it back under "Not in this template".
    const partyStage = staff.getByTestId("stage-party");
    await partyStage.getByRole("button", { name: "6 moments in Dance party" }).click();
    staff.once("dialog", (d) => void d.accept());
    await partyStage.getByRole("button", { name: "Remove Dedications", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Remove Dedications", exact: true })).toHaveCount(0);
    await expect(partyStage.getByRole("button", { name: "Add Dedications to Dance party" })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Remove Event basics", exact: true })).toHaveCount(0);

    // A stale tab gets a conflict instead of overwriting.
    const stale = await staffContext.newPage();
    await stale.goto(staff.url());
    await staff.getByRole("button", { name: "Rename Closing", exact: true }).click();
    await staff.getByLabel("Label for Closing", { exact: true }).fill("Last dance");
    await staff.getByRole("button", { name: "Save the name of Closing", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Last dance", exact: true })).toBeVisible();
    await stale.getByRole("button", { name: "Rename Cocktail", exact: true }).click();
    await stale.getByLabel("Label for Cocktail", { exact: true }).fill("Cocktail hour");
    await stale.getByRole("button", { name: "Save the name of Cocktail", exact: true }).click();
    await expect(stale.locator("main").getByRole("alert")).toContainText("Someone else saved changes first");
    await expect(stale.getByLabel("Label for Cocktail", { exact: true })).toHaveValue("Cocktail hour");
    await stale.close();

    // The preview shows the client's sections in the saved order, without touching any event.
    const plansBefore = (await admin.from("event_plans").select("id").eq("tenant_id", tenant.id)).data!.length;
    await staff.getByRole("link", { name: "Preview" }).click();
    await expect(staff.getByTestId("preview-note")).toContainText("nothing is saved");
    await expect(staff.getByTestId("preview-sections").locator(":scope > li h2")).toHaveText([
      "Event basics", "Contacts and vendors", "DJ expectations and overall preferences",
      "Ceremony", "Cocktail", "Reception entrance", "Dinner", "Special dances", "Dance party", "Last dance",
    ]);
    // The grand entrance order holds who is introduced and their songs: no separate Participants and names or Entrance music.
    await expect(staff.getByTestId("preview-reception_entrance")).toContainText("Grand entrance order");
    await expect(staff.getByTestId("preview-reception_entrance")).not.toContainText(/Participants and names|Entrance music/);
    await expect(staff.getByTestId("preview-party")).not.toContainText("Dedications");
    expect((await admin.from("event_plans").select("id").eq("tenant_id", tenant.id)).data!.length).toBe(plansBefore);
    await staff.getByRole("link", { name: "Back to the template" }).click();

    // Copy it as a starting point.
    await staff.getByRole("link", { name: "Use as a starting point" }).click();
    await expect(staff.getByRole("radio", { name: /^Wedding\s*3 general sections/ })).toBeChecked();
    await expect(staff.getByLabel("Template name")).toHaveValue("Wedding (copy)");
    await staff.getByLabel("Template name").fill("Wedding (French)");
    await staff.getByRole("button", { name: "Create template" }).click();
    await staff.waitForURL((url) => !url.pathname.endsWith(templateId) && !url.pathname.endsWith("/new"));
    await expect(staff.getByRole("heading", { name: "Wedding (French)" })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Rename Dance party", exact: true })).toBeVisible();

    // A new template from the Simple Party outline, with its own name; the installed starter stays as it was.
    await staff.goto(`/staff/${tenant.slug}/planning-templates/new`);
    await staff.getByRole("radio", { name: /^Simple Party outline/ }).check();
    await expect(staff.getByLabel("Template name")).toHaveValue("Party");
    await staff.getByLabel("Template name").fill("Birthday");
    await staff.getByRole("button", { name: "Create template" }).click();
    await expect(staff.getByRole("heading", { name: "Birthday" })).toBeVisible();
    const birthdayId = staff.url().split("/").pop()!;
    const { data: birthday } = await admin.from("planning_templates").select("starter_key, planning_template_items!planning_template_items_template_fk(key)").eq("id", birthdayId).single();
    expect(birthday!.starter_key).toBeNull();
    expect(birthday!.planning_template_items.map((i) => i.key).sort()).toEqual(["basics", "do_not_play", "must_play", "party"]);

    // The template workspace and its preview fit a phone.
    const phone = await staffContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`/staff/${tenant.slug}/planning-templates/${templateId}`);
    await phone.getByTestId("stage-ceremony").getByRole("button", { name: /moments in Ceremony/ }).click();
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.goto(`/staff/${tenant.slug}/planning-templates/${templateId}/preview`);
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.close();
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
    await expect(client.getByTestId("progress-percent")).toHaveText("20% complete");
    await expect(client.getByTestId("progress-headline")).toHaveText("1 of 5 required answers");
    await expect(client.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
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
    await expect(client.getByTestId("progress-percent")).toHaveText("100% complete");
    await expect(client.getByTestId("progress-headline")).toHaveText("5 of 5 required answers");
    await expect(client.getByText("Event basics is complete.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toEqual({ guest_count: 150, start_time: "18:00", end_time: "01:00", access_notes_none: true });

    // A refresh keeps the open section.
    await client.reload();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
    await expect(client.getByLabel("No special instructions")).toBeChecked();
    // Every available answer is in: the overview offers a review, not "continue".
    await openPlanSection(client, null);
    await expect(client.getByTestId("plan-primary")).toHaveText("Review your plan");
    // Overview is a navigation item like the sections (progress line, current state), and Back/Forward follow it.
    expect(sectionParam(client)).toBeNull();
    const picker = client.getByTestId("section-picker");
    await picker.locator("summary").first().click();
    await expect(picker.getByTestId("nav-overview")).toHaveAttribute("aria-current", "page");
    await expect(picker.getByTestId("nav-overview")).toHaveText(/Overview\s*100% complete/);
    await expect(picker.getByTestId("nav-basics")).not.toHaveAttribute("aria-current", "page");
    await picker.locator("summary").first().click();
    await client.goBack();
    await expect(client.locator("#plan-panel-basics")).toBeVisible();
    expect(sectionParam(client)).toBe("basics");
    await client.goForward();
    await expect(client.locator("#plan-panel-overview")).toBeVisible();
    expect(sectionParam(client)).toBeNull();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
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
    await staff.goto(`${staffPlanningUrl}?section=basics`);
    await expect(staff.getByText("Last saved by the client.")).toBeVisible();
    await expect(staff.getByLabel("Guest count (needed)")).toHaveValue("175");
    await openPlanSection(staff, "plan-structure");
    const apply = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Replace the structure with a template") });
    await apply.getByLabel("Template").selectOption({ label: "Wedding" });
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByRole("alert")).toContainText("Check the box to confirm replacing the structure.");
    await apply.getByLabel(/I understand this replaces/).check();
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByText("Template applied: 1 kept, 34 added, 0 hidden. No answers were removed.")).toBeVisible();
    // The staff overview lists what still needs attention, in plan order, and opens it.
    await openPlanSection(staff, null);
    const attention = staff.getByTestId("plan-attention");
    await expect(attention.getByRole("link").first()).toContainText("Contacts and vendors");
    await expect(staff.getByTestId("progress-headline")).toHaveText("5 of 47 required answers");
    await expect(staff.getByTestId("progress-percent")).toHaveText("11% complete");
    await attention.getByRole("link", { name: /Ceremony/ }).click();
    await expect(staff.locator("#plan-panel-ceremony")).toBeVisible();
    expect(new URL(staff.url()).searchParams.get("section")).toBe("ceremony");
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175, venue_room: "Grand hall" });

    await client.reload();
    await expect(stageNav(client)).toHaveText([
      /1\. Ceremony/, /2\. Cocktail/, /3\. Reception entrance/, /4\. Dinner/, /5\. Special dances/, /6\. Dance party/, /7\. Last dance/,
    ]);
    const ceremony = await openPlanSection(client, "ceremony");
    await expect(ceremony).toContainText("Processional");
    // Everyone walks in through Processional: no separate Couple entrance in a new Wedding plan.
    await expect(ceremony.getByTestId("moment-couple_entrance")).toHaveCount(0);
    // Every moment has an editor now: nothing says it isn't open yet.
    await expect(client.getByText(/Not open for planning yet|Not available yet/)).toHaveCount(0);
    await expect(client.getByTestId("section-picker").getByTestId("nav-contacts_vendors")).toContainText("Not started");
    // Event basics (5 of 5), the six stage editors' 13 requirements (guest entry and the grand entrance decision among them), the 16 song
    // moments, who walks in, MC and speeches (the grand entrance order waits for its decision), contacts (2),
    // preferences (4), music styles (2), and the activities and dedications this trimmed template kept (2), none answered yet.
    await expect(client.getByTestId("progress-headline")).toHaveText("5 of 47 required answers");
    await expect(client.getByTestId("progress-percent")).toHaveText("11% complete");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    // Continue planning opens the first section, in plan order, with answers still needed.
    await openPlanSection(client, null);
    await expect(client.getByText(/Progress covers the \d+ sections you can fill in now\./)).toBeVisible();
    await expect(client.getByTestId("plan-primary")).toHaveText("Continue planning");
    await client.getByTestId("plan-primary").click();
    expect(sectionParam(client)).toBe("contacts_vendors");
    await expect(client.locator("#plan-panel-contacts_vendors")).toBeVisible();
  });

  test("the client fills ceremony details on a phone: venue reuse, discuss with DJ, guest arrival needed, completion and a persisted reload", async () => {
    const card = await openPlanSection(client, "ceremony");
    const details = card.getByTestId("details-ceremony");
    const status = card.getByTestId("details-status");
    await expect(status).toContainText("Not started");
    await details.getByLabel("Same as the event venue (Château E2E, 1 Rue du Lac, Gatineau)").check();
    await details.getByLabel("Ceremony start (needed)").fill("16:00");
    await details.getByLabel("Not sure yet — discuss with your DJ").check();
    await expect(details.getByText("All changes saved")).toBeVisible();
    await expect(details.getByRole("list", { name: "What Ceremony details needs" })).toContainText("Discuss with your DJ (still open)");
    await expect(status).toContainText("In progress");
    // Discuss with DJ is open, never complete; the section and the list both say so.
    await expect(card.getByTestId("section-status")).toContainText("1 to discuss");
    await expect(client.getByTestId("section-picker").getByTestId("nav-ceremony")).toContainText("1 to discuss");
    await expect(details.getByText("Equipment answers are planning information for your DJ to review.", { exact: false })).toBeVisible();
    await details.getByLabel("Needed", { exact: true }).check();
    // The guest arrival time is needed too; no time is assumed.
    await expect(details.getByRole("list", { name: "What Ceremony details needs" })).toContainText(/Guest arrival time\s*Not answered yet/);
    await expect(status).toContainText("In progress");
    await expect(details.getByRole("checkbox", { name: /Guest arrival: next day/ })).toHaveCount(0);
    // Optional fields don't block completion.
    await details.getByLabel("Guest arrival (needed)").fill("15:30");
    await expect(details.getByText("Ceremony details is complete.")).toBeVisible();
    await expect(status).toContainText("Complete");
    await expect.poll(async () => (await stageRow(eventId, "ceremony"))!.answers).toEqual({ location_source: "event_venue", guest_arrival_time: "15:30", start_time: "16:00", microphones: "needed" });

    // A refresh reopens the same section, with the saved answers.
    await client.reload();
    await expect(client.locator("#plan-panel-ceremony")).toBeVisible();
    const again = client.getByTestId("details-ceremony");
    await expect(again.getByLabel("Ceremony start (needed)")).toHaveValue("16:00");
    await expect(again.getByLabel("Guest arrival (needed)")).toHaveValue("15:30");
    await expect(again.getByLabel("Needed", { exact: true })).toBeChecked();
    await expect(again.getByLabel(/Same as the event venue/)).toBeChecked();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("overnight times need an explicit next day; timing conflicts are flagged without reordering the stages", async () => {
    const party = await openPlanSection(client, "party");
    const details = party.getByTestId("details-party");
    await details.getByLabel(/Same as the event venue/).check();
    await details.getByLabel("Party start (needed)").fill("22:00");
    // An evening time is just a time: "Next day" appears only where it can matter.
    await expect(details.getByRole("checkbox", { name: /next day/ })).toHaveCount(0);
    await details.getByLabel("Party end (optional)").fill("01:00");
    await expect(details.getByText('The end must be after the start. If it ends after midnight, check "Next day".')).toBeVisible();
    await expect(details.getByRole("checkbox", { name: /Party start: next day/ })).toHaveCount(0);
    await expect(details.getByRole("alert")).toContainText("Fix the highlighted answer to save.");
    expect(await stageRow(eventId, "party")).toBeNull();
    await details.getByLabel("Party end: next day (Sun, Aug 15)").check();
    await expect(details.getByText("All changes saved")).toBeVisible();
    expect((await stageRow(eventId, "party"))!.answers).toMatchObject({ start_time: "22:00", end_time: "01:00", end_next_day: true });
    // A saved next-day time keeps its mark on screen, and editing the time keeps it.
    await client.reload();
    const again = (await openPlanSection(client, "party")).getByTestId("details-party");
    await expect(again.getByLabel("Party end: next day (Sun, Aug 15)")).toBeChecked();
    // Retried: an edit made before the reloaded page hydrates is reset to the saved answer.
    await expect(async () => {
      await again.getByLabel("Party end (optional)").fill("01:30");
      await expect.poll(async () => (await stageRow(eventId, "party"))!.answers, { timeout: 3_000 }).toMatchObject({ start_time: "22:00", end_time: "01:30", end_next_day: true });
    }).toPass();
    await expect(again.getByText("All changes saved")).toBeVisible();

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

  test("leaving a section resets its questions to collapsed; input, pending and failed saves survive, and navigating saves nothing", async () => {
    await client.setViewportSize({ width: 390, height: 844 });
    const isAction = (route: { request(): { method(): string; headers(): Record<string, string> } }) =>
      route.request().method() === "POST" && Boolean(route.request().headers()["next-action"]);
    const ceremony = await openPlanSection(client, "ceremony");
    const signing = ceremony.getByTestId("moment-ceremony_signing");
    const recessional = ceremony.getByTestId("moment-recessional");
    const isOpen = (card: Locator) => card.evaluate((el) => (el as HTMLDetailsElement).open);
    const untouched = await stageRow(eventId, "pre_ceremony_music");

    // Next: the questions opened here are collapsed when the client comes back with Previous.
    await openPlanMoment(client, "ceremony", "ceremony_signing");
    await openPlanMoment(client, "ceremony", "recessional");
    await ceremony.getByRole("link", { name: /Next: Cocktail/ }).click();
    expect(sectionParam(client)).toBe("cocktail");
    await client.locator("#plan-panel-cocktail").getByRole("link", { name: /Previous: Ceremony/ }).click();
    expect(sectionParam(client)).toBe("ceremony");
    expect(await isOpen(signing)).toBe(false);
    expect(await isOpen(recessional)).toBe(false);
    // Opening a question within the section, or a save, never collapses the others.
    await openPlanMoment(client, "ceremony", "ceremony_signing");
    await openPlanMoment(client, "ceremony", "recessional");
    expect(await isOpen(signing)).toBe(true);

    // A waiting (debounced) save is sent when leaving through the section list; the input survives.
    await recessional.getByLabel("DJ's choice", { exact: true }).check();
    await openPlanSection(client, "dinner");
    await expect.poll(async () => (await stageRow(eventId, "recessional"))?.answers).toEqual({ choice: "dj_choice" });
    await openPlanSection(client, "ceremony");
    expect(await isOpen(recessional)).toBe(false);
    expect(await isOpen(signing)).toBe(false);
    await openPlanMoment(client, "ceremony", "recessional");
    await expect(recessional.getByLabel("DJ's choice", { exact: true })).toBeChecked();

    // A failed save is kept, flagged on the collapsed question, and retried after coming back (Back and Forward too).
    await client.route(`**${planningUrl}*`, (route) => (isAction(route) ? route.abort() : route.continue()));
    await recessional.getByLabel("Not sure yet — discuss with your DJ").check();
    await expect(recessional.getByRole("alert")).toContainText("Couldn't save");
    await openPlanSection(client, "party");
    await client.goBack();
    expect(sectionParam(client)).toBe("ceremony");
    expect(await isOpen(recessional)).toBe(false);
    await expect(recessional.locator(":scope > summary")).toContainText("Not saved");
    await client.unroute(`**${planningUrl}*`);
    await openPlanMoment(client, "ceremony", "recessional");
    await expect(recessional.getByLabel("Not sure yet — discuss with your DJ")).toBeChecked();
    await recessional.getByRole("button", { name: "Retry saving" }).click();
    await expect(recessional.getByText("All changes saved")).toBeVisible();
    expect((await stageRow(eventId, "recessional"))?.answers).toEqual({ choice: "discuss" });
    await client.goForward();
    expect(sectionParam(client)).toBe("party");
    await client.goBack();
    expect(await isOpen(recessional)).toBe(false);

    // Navigating itself saved nothing else.
    expect(await stageRow(eventId, "pre_ceremony_music")).toEqual(untouched);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("staff edit stage details reusing Event basics; hidden stages keep their answers; nothing contractual changes", async () => {
    await staff.goto(staffPlanningUrl);
    const card = await openPlanSection(staff, "dinner");
    const dinner = card.getByTestId("details-dinner");
    await dinner.getByLabel(/Same as the event venue/).check();
    await dinner.getByLabel("Dinner start (needed)").fill("19:30");
    await dinner.getByLabel("Same as the guest count in Event basics (175)").check();
    await expect(dinner.getByText("All changes saved")).toBeVisible();
    await expect(card.getByTestId("details-status")).toContainText("Complete");
    expect((await stageRow(eventId, "dinner"))).toMatchObject({ answers: { location_source: "event_venue", start_time: "19:30", guest_count_source: "basics" }, updated_by_actor: "staff" });
    // The reuse is stored as a choice, not a copied number.
    expect((await stageRow(eventId, "dinner"))!.answers).not.toHaveProperty("guest_count");
    // Staff and client read the same progress for the ceremony the client completed.
    await expect(staff.locator("#plan-panel-ceremony").getByTestId("details-status")).toContainText("Complete");

    await openPlanSection(staff, "plan-structure");
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
    await expect(staff.getByTestId("staff-stage-cocktail")).toHaveCount(1);
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
    await openPlanSection(staff, "plan-structure");
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
    // Dinner details are the stage's own; the other moments follow in their configured order.
    await expect(dinner.getByRole("heading", { name: "Dinner details", exact: true })).toBeVisible();
    // The checklist names the same thing as the heading above it.
    await expect(dinner.getByTestId("details-dinner")).toContainText(/Dinner details is complete|of \d+ needed answers/);
    await expect(dinner.getByRole("list", { name: "Moments in Dinner" }).locator(":scope > li")).toHaveText([/Background music/, /Speeches and toasts/, /Activities/, /Cake cutting/]);
    await expect(dinner.getByTestId("details-dinner").getByLabel("Dinner start (needed)")).toHaveValue("19:30");

    // Template edits don't reach this event's plan.
    const { data: template } = await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding").single();
    await staff.goto(`/staff/${tenant.slug}/planning-templates/${template!.id}`);
    await staff.getByRole("button", { name: "Rename Ceremony", exact: true }).click();
    await staff.getByLabel("Label for Ceremony", { exact: true }).fill("Vows");
    await staff.getByRole("button", { name: "Save the name of Ceremony", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Vows", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("section-picker").getByTestId("nav-ceremony")).toContainText("Ceremony");

    // The staff planning page fits a phone too.
    const phone = await staffContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(staffPlanningUrl);
    await expect(phone.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await openPlanSection(phone, "ceremony");
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await openPlanSection(phone, null);
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
    // Event basics, contacts, preferences, the six stage editors, the 15 song moments (Processional included; no separate
    // Couple entrance or Entrance music), MC, introductions (set aside until a grand entrance is planned, still read-only),
    // speeches, music styles and both activities (this trimmed template has no Dedications) are read-only while archived.
    await expect(staff.getByText("Unarchive the event to edit planning.")).toHaveCount(30);
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
