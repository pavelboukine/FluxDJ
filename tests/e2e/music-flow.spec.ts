/**
 * Songs in planning, in a real browser against local Supabase, inside a
 * dedicated test tenant with a booked wedding (booking set up through the
 * database functions the app calls; see booking.ts). Everything about songs
 * goes through the UI:
 *   - the client (phone-sized) adds, edits, reorders and removes songs, with
 *     undo, and a reload keeps the order;
 *   - "Paste a list" previews, flags ambiguous lines, lets them be corrected
 *     and imports once, whatever the clicks;
 *   - likely duplicates and play / do-not-play contradictions are flagged and
 *     nothing is moved;
 *   - DJ's choice, no requests, not applicable and discuss with DJ, with
 *     truthful progress; cue songs keep labels and instructions;
 *   - saves pending, failing or from a stale tab never lose or overwrite songs;
 *   - staff see and edit the same songs; hiding keeps them; archived plans are
 *     read-only; another business can't open the plan;
 *   - nothing contractual changes.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanMoment, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-music-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Opens a moment's card in its stage's section (unless already open); returns the moment's song editor. */
async function openMoment(page: Page, stageKey: string, momentKey: string): Promise<Locator> {
  return (await openPlanMoment(page, stageKey, momentKey)).getByTestId(`music-${momentKey}`);
}

/** Fills the "Add a song" form of an editor and adds the song. */
async function addSong(editor: Locator, song: { title: string; artist: string; version?: string; link?: string; notes?: string; cue?: string }) {
  const form = editor.getByTestId(/-add$/);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  if (song.cue !== undefined) await form.getByLabel("Cue (optional)").fill(song.cue);
  await form.getByLabel("Title", { exact: true }).fill(song.title);
  await form.getByLabel("Artist", { exact: true }).fill(song.artist);
  await form.getByLabel("Version (optional)").fill(song.version ?? "");
  await form.getByLabel("Link (optional)").fill(song.link ?? "");
  await form.getByLabel(/^(Notes|Instructions) \(optional\)$/).fill(song.notes ?? "");
  await form.getByRole("button", { name: "Add song" }).click();
}

const rows = (editor: Locator) => editor.getByTestId("song-row");

async function responses(eventId: string, key: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return (await admin.from("event_plan_responses").select("answers, revision, updated_by_actor").eq("item_id", item.id).maybeSingle()).data as
    { answers: { songs?: { id: string; title: string; artist: string; version?: string; link?: string; notes?: string; cue?: string }[]; choice?: string }; revision: number; updated_by_actor: string } | null;
}

test.describe.serial("songs in planning", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractual = "";
  let planningUrl = "";
  let staffPlanningUrl = "";
  let firstIds: string[] = [];

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("music", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E Music Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14",
      venue_name: "Château E2E", internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    // A wedding plan from the starter template (template screens are covered by planning-flow.spec.ts).
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    await bookEvent(tenant, eventId, clientEmail);
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

  test("the client adds, edits, reorders and removes songs on a phone; a reload keeps the order", async () => {
    const mustPlay = await openMoment(client, "party", "must_play");
    await expect(client.getByTestId("moment-must_play")).toContainText("Not started");
    await expect(mustPlay).toContainText("Songs or a choice");

    // The add form checks a song before it joins the list.
    await addSong(mustPlay, { title: "One More Time", artist: "", link: "" });
    await expect(mustPlay.getByTestId(/-add$/)).toContainText("Enter the artist.");
    await addSong(mustPlay, { title: "One More Time", artist: "Daft Punk", link: "http://example.com/x" });
    await expect(mustPlay.getByTestId(/-add$/)).toContainText("Enter a full https:// address");
    await addSong(mustPlay, { title: "One More Time", artist: "Daft Punk", version: "Radio edit", link: "https://example.com/omt", notes: "Peak of the night" });
    await addSong(mustPlay, { title: "Dancing Queen", artist: "ABBA" });
    await addSong(mustPlay, { title: "September", artist: "Earth, Wind & Fire" });
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();
    await expect(rows(mustPlay)).toHaveCount(3);
    await expect(rows(mustPlay).first()).toContainText("1. One More Time by Daft Punk");
    await expect(rows(mustPlay).first()).toContainText("Version: Radio edit");
    await expect(rows(mustPlay).first()).toContainText("Notes: Peak of the night");
    const link = rows(mustPlay).first().getByRole("link", { name: "Open link (example.com)" });
    await expect(link).toHaveAttribute("href", "https://example.com/omt");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(client.getByTestId("moment-must_play")).toContainText("Complete");
    firstIds = (await responses(eventId, "must_play"))!.answers.songs!.map((s) => s.id);
    expect(firstIds).toHaveLength(3);

    // Reorder with buttons; ids travel with the songs.
    await mustPlay.getByRole("button", { name: 'Move "September" up' }).click();
    await mustPlay.getByRole("button", { name: 'Move "September" up' }).click();
    await expect(mustPlay.getByRole("button", { name: 'Move "September" up' })).toBeDisabled();
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await responses(eventId, "must_play"))!.answers.songs!.map((s) => s.id)).toEqual([firstIds[2], firstIds[0], firstIds[1]]);

    // Edit in place.
    await mustPlay.getByRole("button", { name: 'Edit "Dancing Queen"' }).click();
    const row = rows(mustPlay).filter({ hasText: "Dancing Queen" });
    await row.getByLabel("Version (optional)").fill("Live");
    await row.getByRole("button", { name: 'Done editing "Dancing Queen"' }).click();
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();

    // Remove, undo, remove for good.
    await mustPlay.getByRole("button", { name: 'Remove "One More Time"' }).click();
    await expect(mustPlay.getByRole("status").filter({ hasText: "Removed “One More Time”." })).toBeVisible();
    await mustPlay.getByRole("button", { name: "Undo" }).click();
    await expect(rows(mustPlay)).toHaveCount(3);
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await responses(eventId, "must_play"))!.answers.songs!.map((s) => s.id)).toEqual([firstIds[2], firstIds[0], firstIds[1]]);
    await mustPlay.getByRole("button", { name: 'Remove "September"' }).click();
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openMoment(client, "party", "must_play");
    await expect(rows(again)).toHaveText([/1\. One More Time by Daft Punk/, /2\. Dancing Queen by ABBA.*Version: Live/]);
    const saved = (await responses(eventId, "must_play"))!;
    expect(saved.answers.songs!.map((s) => s.id)).toEqual([firstIds[0], firstIds[1]]);
    expect(saved.updated_by_actor).toBe("client");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("paste a list: preview, correct flagged lines, then import exactly once", async () => {
    const list = await openMoment(client, "party", "play_if_possible");
    const paste = list.getByTestId(/-paste$/);
    await paste.locator("summary").click();
    await paste.getByLabel("One song per line, as Artist - Title").fill("1. Queen - Don't Stop Me Now\n\nWonderwall\nJay-Z - Song - Remix\n• Chic – Le Freak");
    await paste.getByRole("button", { name: "Preview" }).click();
    const preview = paste.getByTestId("paste-row");
    await expect(preview).toHaveCount(4);
    await expect(preview.nth(1)).toContainText('No " - " found: add the artist.');
    await expect(preview.nth(2)).toContainText("More than one dash");
    const importButton = paste.getByRole("button", { name: "Import 4 songs" });
    await expect(importButton).toBeDisabled();
    await expect(paste.getByRole("alert")).toContainText("Complete or untick 2 lines before importing.");
    expect(await responses(eventId, "play_if_possible")).toBeNull();

    await preview.nth(1).getByLabel("Artist").fill("Oasis");
    await preview.nth(2).getByLabel("Looks right").check();
    await expect(importButton).toBeEnabled();
    // A double click imports once: the preview closes with the first.
    await importButton.dblclick();
    await expect(paste.getByRole("status")).toHaveText("Imported 4 songs. They save automatically.");
    await expect(rows(list)).toHaveText([/Don't Stop Me Now by Queen/, /Wonderwall by Oasis/, /Song - Remix by Jay-Z/, /Le Freak by Chic/]);
    await expect(list.getByText("All changes saved")).toBeVisible();
    const saved = (await responses(eventId, "play_if_possible"))!;
    expect(saved.answers.songs!.map((s) => `${s.artist} / ${s.title}`)).toEqual(["Queen / Don't Stop Me Now", "Oasis / Wonderwall", "Jay-Z / Song - Remix", "Chic / Le Freak"]);
    expect(new Set(saved.answers.songs!.map((s) => s.id)).size).toBe(4);
    expect(saved.revision).toBe(1);
  });

  test("likely duplicates and play / do-not-play contradictions are flagged; nothing is moved", async () => {
    const mustPlay = await openMoment(client, "party", "must_play");
    await addSong(mustPlay, { title: "dancing  queen", artist: "abba" });
    await expect(rows(mustPlay).nth(2)).toContainText("Possible duplicate: the same title and artist appear earlier in this list.");
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();

    const dnp = await openMoment(client, "party", "do_not_play");
    await expect(dnp.getByLabel("Nothing to exclude")).toBeEnabled();
    await addSong(dnp, { title: "Le Freak", artist: "CHIC" });
    await expect(rows(dnp).first()).toContainText("Also listed to play in Play if possible. Check which one is right; nothing was changed.");
    await expect(dnp.getByLabel("Nothing to exclude")).toBeDisabled();
    await expect(dnp.getByText("All changes saved")).toBeVisible();
    const playList = await openMoment(client, "party", "play_if_possible");
    await expect(rows(playList).nth(3)).toContainText("Also listed under Do not play.");
    expect((await responses(eventId, "play_if_possible"))!.answers.songs).toHaveLength(4);
    expect((await responses(eventId, "must_play"))!.answers.songs).toHaveLength(3);
    await mustPlay.getByRole("button", { name: 'Remove "dancing queen"', exact: true }).click();
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();
  });

  test("answer states: DJ's choice, not applicable and discuss with the DJ, with truthful progress", async () => {
    const headline = client.getByTestId("progress-headline");
    const before = Number(/^(\d+) of/.exec((await headline.textContent()) ?? "")![1]);

    const cocktail = await openMoment(client, "cocktail", "cocktail_music");
    await cocktail.getByLabel("DJ's choice: no suggestions").check();
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-cocktail_music")).toContainText("Complete");
    await expect(cocktail.getByText(/To add songs, choose/)).toBeVisible();

    const cake = await openMoment(client, "dinner", "cake_cutting");
    await cake.getByLabel("Not applicable: this moment won't happen").check();
    await expect(cake.getByText("All changes saved")).toBeVisible();
    await expect(cake).toContainText(`The moment stays in your plan; only ${tenant.displayName} can remove it.`);
    await expect(cake).toContainText("Not needed (you said so)");

    const final = await openMoment(client, "closing", "final_song");
    await final.getByLabel(`Not sure yet, discuss with ${tenant.displayName}`).check();
    await addSong(final, { title: "Time of My Life", artist: "Bill Medley & Jennifer Warnes" });
    await expect(final.getByText("All changes saved")).toBeVisible();
    await expect(final).toContainText(`Discuss with ${tenant.displayName} (still open)`);
    await expect(client.getByTestId("moment-final_song")).toContainText("In progress");
    await expect(client.locator("#plan-panel-closing").getByTestId("section-status")).toContainText("1 to discuss");

    // DJ's choice and not applicable count; discuss stays open.
    await expect(headline).toHaveText(new RegExp(`^${before + 2} of \\d+ required answers$`));
    await client.reload();
    await expect(client.getByTestId("progress-headline")).toHaveText(new RegExp(`^${before + 2} of `));
    // Not applicable keeps the moment in the plan.
    await expect(await openMoment(client, "dinner", "cake_cutting")).toContainText("Not needed (you said so)");
    expect((await responses(eventId, "cake_cutting"))!.answers).toEqual({ choice: "not_applicable" });
  });

  test("moment songs keep cue labels, instructions and order", async () => {
    const entrance = await openMoment(client, "reception_entrance", "entrance_music");
    await expect(entrance).toContainText("The one place for reception entrance songs.");
    await addSong(entrance, { cue: "Wedding party", title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", notes: "Start at 0:45" });
    await addSong(entrance, { cue: "Couple", title: "Signed, Sealed, Delivered", artist: "Stevie Wonder", version: "Live", notes: "Fade after the first chorus" });
    await expect(entrance.getByText("All changes saved")).toBeVisible();
    await client.reload();
    const again = await openMoment(client, "reception_entrance", "entrance_music");
    await expect(rows(again).nth(0)).toContainText("Wedding party");
    await expect(rows(again).nth(0)).toContainText("Instructions: Start at 0:45");
    await expect(rows(again).nth(1)).toContainText("Couple");
    await expect(rows(again).nth(1)).toContainText("Version: Live");
    expect((await responses(eventId, "entrance_music"))!.answers.songs!.map((s) => `${s.cue}: ${s.title} (${s.notes})`)).toEqual([
      "Wedding party: Uptown Funk (Start at 0:45)",
      "Couple: Signed, Sealed, Delivered (Fade after the first chorus)",
    ]);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("songs added during a pending save survive; a failed save keeps them and retries; a stale tab gets a conflict", async () => {
    const first = await openMoment(client, "special_dances", "first_dance");
    let release = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await addSong(first, { title: "At Last", artist: "Etta James" });
    await expect(first.getByText("Saving…")).toBeVisible();
    await addSong(first, { title: "Perfect", artist: "Ed Sheeran", notes: "Play fully" });
    release();
    await expect(first.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await responses(eventId, "first_dance"))?.answers.songs?.map((s) => s.title)).toEqual(["At Last", "Perfect"]);
    await client.unroute(`**${planningUrl}*`);

    await client.route(`**${planningUrl}*`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await first.getByRole("button", { name: 'Move "Perfect" up' }).click();
    await expect(first.getByRole("alert")).toContainText("Couldn't save. Check your connection and retry. Your answers are still here.");
    await expect(rows(first)).toHaveText([/Perfect/, /At Last/]);
    await client.unroute(`**${planningUrl}*`);
    await first.getByRole("button", { name: "Retry saving" }).click();
    await expect(first.getByText("All changes saved")).toBeVisible();
    expect((await responses(eventId, "first_dance"))!.answers.songs!.map((s) => s.title)).toEqual(["Perfect", "At Last"]);

    const other = await clientContext.newPage();
    await other.goto(planningUrl);
    const stale = await openMoment(other, "special_dances", "first_dance");
    await addSong(first, { title: "Can't Help Falling in Love", artist: "Elvis Presley" });
    await expect(first.getByText("All changes saved")).toBeVisible();
    await stale.getByRole("button", { name: 'Remove "Perfect"' }).click();
    await expect(stale.getByRole("alert")).toContainText("changed in another tab or window");
    expect((await responses(eventId, "first_dance"))!.answers.songs!.map((s) => s.title)).toEqual(["Perfect", "At Last", "Can't Help Falling in Love"]);
    await other.close();
  });

  test("staff see and edit the same songs; hiding keeps them; archived plans are read-only; other businesses get nothing", async () => {
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByTestId("staff-plan-overview")).toBeVisible();
    const first = await openMoment(staff, "special_dances", "first_dance");
    await expect(rows(first)).toHaveText([/Perfect/, /At Last/, /Can't Help Falling in Love/]);
    await first.getByRole("button", { name: 'Edit "At Last"' }).click();
    await rows(first).filter({ hasText: "At Last" }).getByLabel("Instructions (optional)").fill("Second half only");
    await expect(first.getByText("All changes saved")).toBeVisible();
    expect((await responses(eventId, "first_dance"))!).toMatchObject({ updated_by_actor: "staff" });

    // Hide Must play: it leaves the client's plan with its songs kept; Restore brings them back.
    await openPlanSection(staff, "plan-structure");
    await staff.getByRole("button", { name: "Hide Must play from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Must play", exact: true })).toBeVisible();
    await client.reload();
    await openPlanSection(client, "party");
    await expect(client.getByTestId("moment-must_play")).toHaveCount(0);
    expect((await responses(eventId, "must_play"))!.answers.songs).toHaveLength(2);
    await staff.getByRole("button", { name: "Restore Must play", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Must play from the client", exact: true })).toBeVisible();
    await client.reload();
    const mustPlay = await openMoment(client, "party", "must_play");
    await expect(rows(mustPlay)).toHaveText([/One More Time/, /Dancing Queen/]);

    // Archived: staff editors are read-only, the client is closed out.
    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", eventId));
    await staff.reload();
    await openMoment(staff, "special_dances", "first_dance");
    await expect(staff.getByTestId("music-first_dance")).toContainText("Unarchive the event to edit planning.");
    await expect(staff.getByTestId("music-first_dance").getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await client.reload();
    await expect(client.getByRole("heading", { name: "Planning isn't available" })).toBeVisible();
    await must(admin.from("events").update({ archived_at: null }).eq("id", eventId));

    const other = await createTestTenant("music-other");
    const otherContext = await browser.newContext();
    try {
      const otherStaff = await otherContext.newPage();
      await signInStaff(otherStaff, other.ownerEmail);
      expect((await otherStaff.goto(staffPlanningUrl))?.status()).toBe(404);
      expect((await otherStaff.goto(`/staff/${other.slug}/events/${eventId}/planning`))?.status()).toBe(404);
    } finally {
      await otherContext.close();
      await archiveTestTenant(other);
    }
  });

  test("on a phone nothing scrolls sideways, and the contract, payments and booking are unchanged", async () => {
    await client.reload();
    for (const [stage, moment] of [["party", "must_play"], ["party", "play_if_possible"], ["reception_entrance", "entrance_music"], ["special_dances", "first_dance"]]) {
      const editor = await openMoment(client, stage, moment);
      await editor.getByRole("button", { name: /^Edit / }).first().click();
    }
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    expect(await contractualState(eventId)).toBe(contractual);
  });
});
