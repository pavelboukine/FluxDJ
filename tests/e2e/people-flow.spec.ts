/**
 * Participants, pronunciation guides, MC and speeches in a real browser
 * against local Supabase, inside a dedicated test tenant with a booked
 * wedding (booking set up through the database functions the app calls; see
 * booking.ts). Everything about people goes through the UI:
 *   - Processional keeps its songs and lists who walks in (people or groups,
 *     no fixed labels), with pronunciation and links to its own songs or the
 *     Couple entrance song, which then can't be removed;
 *   - Introductions are the one reception participant editor; entries share
 *     Entrance music songs by link, titles follow edits, linked songs can't
 *     be removed (also from a stale tab), hidden songs are shown as such;
 *   - the MC and speeches (exact time with next day, cue, undecided);
 *   - pending, failed and stale saves keep entries;
 *   - staff edit the same entries on a phone; nothing contractual changes.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanMoment, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-people-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Opens a moment's card through its stage's section (the client's and the staff page navigate the same way). */
async function openMoment(page: Page, stageKey: string, momentKey: string): Promise<Locator> {
  return openPlanMoment(page, stageKey, momentKey);
}

async function addSong(scope: Locator, song: { title: string; artist: string; cue?: string }) {
  const form = scope.getByTestId(/^music-.*-add$/);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  if (song.cue !== undefined) await form.getByLabel("Cue (optional)").fill(song.cue);
  await form.getByLabel("Title", { exact: true }).fill(song.title);
  await form.getByLabel("Artist", { exact: true }).fill(song.artist);
  await form.getByRole("button", { name: "Add song" }).click();
}

/** Opens an entry list's add form, fills it and adds the entry. */
async function addEntry(scope: Locator, testId: string, fill: (form: Locator) => Promise<void>) {
  const form = scope.getByTestId(testId);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  await fill(form);
  await form.getByRole("button", { name: "Add", exact: true }).click();
}

async function answers(eventId: string, key: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return ((await admin.from("event_plan_responses").select("answers").eq("item_id", item.id).maybeSingle()).data?.answers ?? null) as Record<string, unknown> & {
    songs?: { id: string; title: string }[]; participants?: { id: string; names: string; song_id?: string; pronunciation?: string }[];
    entries?: { id: string; names?: string; speaker?: string; song_id?: string; timing?: string; time?: string; next_day?: boolean; cue?: string }[];
  } | null;
}

test.describe.serial("people in planning", () => {
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
    tenant = await createTestTenant("people", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E People Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14", venue_name: "Château E2E",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
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

  test("Processional keeps its songs and lists who walks in, with pronunciation and song links", async () => {
    const card = await openMoment(client, "ceremony", "processional");
    const music = card.getByTestId("music-processional");
    await addSong(music, { cue: "Wedding party", title: "Canon in D", artist: "Pachelbel" });
    await addSong(music, { cue: "Partner", title: "A Thousand Years", artist: "Christina Perri" });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("1 of 2 needed answers");

    const people = card.getByTestId("processional-participants");
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByRole("button", { name: "Add", exact: true }).click(); // a name is needed first
      await expect(form).toContainText("Enter the name or names.");
      await form.getByLabel("Name or names").fill("Sam & Jo");
      await form.getByLabel("Role or relationship (optional)").fill("Wedding party");
      await form.getByLabel("Song (optional)").selectOption({ label: "Wedding party: Canon in D by Pachelbel" });
    });
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("The flower children");
      await form.getByLabel("Song (optional)").selectOption({ label: "Wedding party: Canon in D by Pachelbel" });
    });
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Alex Dubois with their mother Dana");
      await form.getByLabel("Pronunciation guide (optional)").fill("ah-LEX doo-BWAH");
      await form.getByLabel("Instructions (optional)").fill("Pause at the aisle");
      await form.getByLabel("Song (optional)").selectOption({ label: "Partner: A Thousand Years by Christina Perri" });
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    const rows = people.getByTestId("entry-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText("3. Alex Dubois with their mother Dana (say: ah-LEX doo-BWAH)");
    await expect(rows.nth(2)).toContainText("Song: Partner: A Thousand Years by Christina Perri");
    await expect(client.getByTestId("moment-processional")).toContainText("Complete");

    // Linked songs show who uses them and can't be removed.
    const canon = music.getByTestId("song-row").filter({ hasText: "Canon in D" });
    await expect(canon).toContainText("Linked to: Sam & Jo, The flower children");
    await expect(canon.getByRole("button", { name: 'Remove "Canon in D"' })).toBeDisabled();
    // Renaming the song shows through the link; people are untouched.
    await music.getByRole("button", { name: 'Edit "A Thousand Years"' }).click();
    await music.getByTestId("song-row").filter({ hasText: "A Thousand Years" }).getByLabel("Title", { exact: true }).fill("A Thousand Years (Piano)");
    await expect(rows.nth(2)).toContainText("Song: Partner: A Thousand Years (Piano) by Christina Perri");
    // Reorder people.
    await people.getByRole("button", { name: 'Move "Alex Dubois with their mother Dana" up' }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openMoment(client, "ceremony", "processional");
    await expect(again.getByTestId("processional-participants").getByTestId("entry-row")).toHaveText([
      /1\. Sam & Jo/, /2\. Alex Dubois with their mother Dana \(say: ah-LEX doo-BWAH\)/, /3\. The flower children/,
    ]);
    const saved = (await answers(eventId, "processional"))!;
    expect(saved.songs!.map((s) => s.title)).toEqual(["Canon in D", "A Thousand Years (Piano)"]);
    expect(saved.participants!.map((p) => p.song_id)).toEqual([saved.songs![0].id, saved.songs![1].id, saved.songs![0].id]);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("the couple's Processional entry uses its Couple entrance song, entered once; that song can't be removed while linked", async () => {
    const couple = await openMoment(client, "ceremony", "couple_entrance");
    await addSong(couple, { cue: "Couple", title: "At Last", artist: "Etta James" });
    await expect(couple.getByText("All changes saved")).toBeVisible();

    const card = await openMoment(client, "ceremony", "processional");
    const people = card.getByTestId("processional-participants");
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Alex & Taylor");
      await form.getByLabel("Song (optional)").selectOption({ label: "Couple entrance, Couple: At Last by Etta James" });
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    const entry = people.getByTestId("entry-row").filter({ hasText: "Alex & Taylor" });
    await expect(entry).toContainText("Song: Couple entrance, Couple: At Last by Etta James");

    // Linked from Processional: Couple entrance won't remove it, and says where the link is.
    const song = couple.getByTestId("song-row").filter({ hasText: "At Last" });
    await expect(song).toContainText("Linked to: Alex & Taylor");
    await expect(song.getByRole("button", { name: 'Remove "At Last"' })).toBeDisabled();
    await expect(song).toContainText("in Processional (who walks in)");
    // A rename shows through the link.
    await couple.getByRole("button", { name: 'Edit "At Last"' }).click();
    await song.getByLabel("Title", { exact: true }).fill("At Last (Live)");
    await expect(couple.getByText("All changes saved")).toBeVisible();
    await expect(entry).toContainText("Song: Couple entrance, Couple: At Last (Live) by Etta James");

    const processional = (await answers(eventId, "processional"))!;
    const coupleSongs = (await answers(eventId, "couple_entrance"))!.songs!;
    expect(coupleSongs.map((s) => s.title)).toEqual(["At Last (Live)"]);
    expect(processional.songs!.map((s) => s.title)).toEqual(["Canon in D", "A Thousand Years (Piano)"]);
    expect(processional.participants!.find((p) => p.names === "Alex & Taylor")!.song_id).toBe(coupleSongs[0].id);
  });

  test("introductions share Entrance music songs by link; linked songs can't be removed, even from a stale tab", async () => {
    const reception = client.getByTestId("stage-reception_entrance");
    const entrance = await openMoment(client, "reception_entrance", "entrance_music");
    await addSong(entrance, { cue: "Wedding party", title: "Uptown Funk", artist: "Mark Ronson" });
    await addSong(entrance, { cue: "Couple", title: "Signed, Sealed, Delivered", artist: "Stevie Wonder" });
    await expect(entrance.getByText("All changes saved")).toBeVisible();
    await expect(reception).toContainText("Participants and names");
    await expect(reception).toContainText("Included in Introductions");

    // A second tab opened before any link exists.
    const stale = await clientContext.newPage();
    await stale.goto(planningUrl);
    const staleEntrance = await openMoment(stale, "reception_entrance", "entrance_music");

    const intros = await openMoment(client, "reception_entrance", "introductions");
    for (const [names, songLabel] of [["Sam and Jo", "Wedding party: Uptown Funk by Mark Ronson"], ["The wedding party", "Wedding party: Uptown Funk by Mark Ronson"], ["Alex and Taylor Nguyen-Roy", "Couple: Signed, Sealed, Delivered by Stevie Wonder"]]) {
      await addEntry(intros, "introductions-entries-add", async (form) => {
        await form.getByLabel("Names exactly as announced").fill(names);
        if (names.startsWith("Alex")) {
          await form.getByLabel("Pronunciation guide (optional)").fill("NWEN-rwah");
          await form.getByLabel("Introduction wording (optional)").fill("For the first time as a married couple");
        }
        await form.getByLabel("Song (optional)").selectOption({ label: songLabel });
      });
    }
    await expect(intros.getByText("All changes saved")).toBeVisible();
    await expect(intros.getByTestId("entry-row").nth(2)).toContainText("Alex and Taylor Nguyen-Roy (say: NWEN-rwah)");
    await expect(intros.getByTestId("entry-row").nth(0)).toContainText("Song: Wedding party: Uptown Funk by Mark Ronson");
    const saved = (await answers(eventId, "introductions"))!;
    const songs = (await answers(eventId, "entrance_music"))!.songs!;
    expect(saved.entries!.map((e) => e.song_id)).toEqual([songs[0].id, songs[0].id, songs[1].id]);

    // This tab knows the links once saved: the song can't be removed here.
    await client.reload();
    const entranceAgain = await openMoment(client, "reception_entrance", "entrance_music");
    const funk = entranceAgain.getByTestId("song-row").filter({ hasText: "Uptown Funk" });
    await expect(funk).toContainText("Linked to: Sam and Jo, The wedding party");
    await expect(funk.getByRole("button", { name: 'Remove "Uptown Funk"' })).toBeDisabled();
    // The stale tab didn't know: the server refuses, naming the introductions.
    await staleEntrance.getByRole("button", { name: 'Remove "Uptown Funk"' }).click();
    await expect(staleEntrance.getByRole("alert").filter({ hasText: "linked to introductions" })).toHaveText(
      '"Uptown Funk" is linked to introductions (Sam and Jo, The wedding party). Change those introductions first. Use Undo to put the song back.',
    );
    await staleEntrance.getByRole("button", { name: "Undo" }).click();
    await expect(staleEntrance.getByText("All changes saved")).toBeVisible();
    expect((await answers(eventId, "entrance_music"))!.songs!.map((s) => s.title)).toEqual(["Uptown Funk", "Signed, Sealed, Delivered"]);
    await stale.close();

    // Renaming a song shows in the introductions through the link.
    await entranceAgain.getByRole("button", { name: 'Edit "Uptown Funk"' }).click();
    await entranceAgain.getByTestId("song-row").filter({ hasText: "Uptown Funk" }).getByLabel("Title", { exact: true }).fill("Uptown Funk (Radio edit)");
    await expect(entranceAgain.getByText("All changes saved")).toBeVisible();
    const introsAgain = await openMoment(client, "reception_entrance", "introductions");
    await expect(introsAgain.getByTestId("entry-row").nth(1)).toContainText("Song: Wedding party: Uptown Funk (Radio edit) by Mark Ronson");
    expect((await answers(eventId, "introductions"))!.entries!.map((e) => e.names)).toEqual(["Sam and Jo", "The wedding party", "Alex and Taylor Nguyen-Roy"]);
  });

  test("a hidden Entrance music keeps the links, shown as not in the active plan", async () => {
    await staff.goto(staffPlanningUrl);
    await openPlanSection(staff, "plan-structure");
    await staff.getByRole("button", { name: "Hide Entrance music from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Entrance music", exact: true })).toBeVisible();
    await client.reload();
    const intros = await openMoment(client, "reception_entrance", "introductions");
    await expect(intros.getByTestId("entry-row").first()).toContainText("isn't in the active plan (Entrance music is hidden)");
    await staff.getByRole("button", { name: "Restore Entrance music", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Entrance music from the client", exact: true })).toBeVisible();
    await client.reload();
    const back = await openMoment(client, "reception_entrance", "introductions");
    await expect(back.getByTestId("entry-row").first()).toContainText("Song: Wedding party: Uptown Funk (Radio edit) by Mark Ronson");
  });

  test("the MC: someone else with a name and pronunciation; the DJ keeps no one else's details", async () => {
    const mc = await openMoment(client, "reception_entrance", "mc");
    await mc.getByLabel("Someone else").check();
    await expect(client.getByTestId("moment-mc")).toContainText("In progress");
    await mc.getByLabel("MC's name (needed)").fill("Kiara Okafor");
    await mc.getByLabel("Pronunciation guide (optional)").fill("kee-AR-ah oh-KAH-for");
    await mc.getByLabel("Phone or email (optional)").fill("kiara@example.test");
    await mc.getByLabel("Instructions (optional)").fill("Bilingual announcements");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-mc")).toContainText("Complete");
    expect(await answers(eventId, "mc")).toEqual({ mc: "other", name: "Kiara Okafor", pronunciation: "kee-AR-ah oh-KAH-for", contact: "kiara@example.test", notes: "Bilingual announcements" });
    await mc.getByLabel(`${tenant.displayName} (the DJ)`).check();
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "dj", notes: "Bilingual announcements" });
  });

  test("speeches: exact time, next day and cues complete them; undecided stays open; saves keep entries", async () => {
    const card = await openMoment(client, "dinner", "speeches");
    await addEntry(card, "speeches-entries-add", async (form) => {
      await form.getByLabel("Speaker", { exact: true }).fill("Dana Dubois");
      await form.getByLabel("Role or relationship (optional)").fill("Mother");
      await form.getByLabel("At an exact time").check();
      await form.getByLabel("Time", { exact: true }).fill("20:15");
      await form.getByLabel("About how long, in minutes (optional)").fill("5");
      await form.getByLabel("Microphone or AV notes (optional)").fill("Handheld mic");
    });
    await addEntry(card, "speeches-entries-add", async (form) => {
      await form.getByLabel("Speaker", { exact: true }).fill("Priya Raman");
      await form.getByLabel("Pronunciation guide (optional)").fill("PREE-yah rah-MAHN");
      await form.getByLabel("At a moment in the evening").check();
      await form.getByLabel("Moment", { exact: true }).fill("After the main course");
    });
    await addEntry(card, "speeches-entries-add", async (form) => {
      await form.getByLabel("Speaker", { exact: true }).fill("Uncle Leo");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    await expect(card).toContainText("A speech has no time or cue yet");
    await expect(card.getByTestId("entry-row").nth(2)).toContainText("Timing not decided yet");
    await expect(client.getByTestId("moment-speeches")).toContainText("In progress");

    // Edits typed while a save is pending survive.
    let release = () => {};
    let held = false;
    await client.route(`**${planningUrl}*`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await card.getByRole("button", { name: 'Edit "Uncle Leo"' }).click();
    const leo = card.getByTestId("entry-row").filter({ hasText: "Uncle Leo" });
    await leo.getByLabel("At an exact time").check();
    await leo.getByLabel("Time", { exact: true }).fill("00:30");
    await expect(card.getByText("Saving…")).toBeVisible();
    await leo.getByRole("checkbox", { name: /Next day/ }).check();
    release();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await client.unroute(`**${planningUrl}*`);
    await expect.poll(async () => (await answers(eventId, "speeches"))!.entries![2]).toMatchObject({ timing: "time", time: "00:30", next_day: true });
    await expect(card).toContainText("Speeches and toasts is complete.");
    await expect(leo).toContainText("At 00:30 (next day, Sun, Aug 15)");

    // A failed save keeps the edit and retries.
    await client.route(`**${planningUrl}*`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await card.getByRole("button", { name: 'Move "Uncle Leo" up' }).click();
    await expect(card.getByRole("alert")).toContainText("Couldn't save. Check your connection and retry.");
    await client.unroute(`**${planningUrl}*`);
    await card.getByRole("button", { name: "Retry saving" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();
    expect((await answers(eventId, "speeches"))!.entries!.map((e) => e.speaker)).toEqual(["Dana Dubois", "Uncle Leo", "Priya Raman"]);

    // A stale tab gets a conflict and overwrites nothing.
    const other = await clientContext.newPage();
    await other.goto(planningUrl);
    const otherCard = await openMoment(other, "dinner", "speeches");
    await card.getByRole("button", { name: 'Remove "Priya Raman"' }).click();
    await expect(card.getByRole("status").filter({ hasText: "Removed “Priya Raman”." })).toBeVisible();
    await expect(card.getByText("All changes saved")).toBeVisible();
    await otherCard.getByRole("button", { name: 'Move "Uncle Leo" up' }).click();
    await expect(otherCard.getByRole("alert")).toContainText("changed in another tab or window");
    expect((await answers(eventId, "speeches"))!.entries!.map((e) => e.speaker)).toEqual(["Dana Dubois", "Uncle Leo"]);
    await other.close();
    // Undo brings the speech back with its cue.
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();
    expect((await answers(eventId, "speeches"))!.entries!.map((e) => e.cue ?? e.time)).toEqual(["20:15", "00:30", "After the main course"]);
  });

  test("staff on a phone see and edit the same people; nothing scrolls sideways; nothing contractual changes", async () => {
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByTestId("staff-plan-overview")).toBeVisible();
    const intros = await openMoment(staff, "reception_entrance", "introductions");
    await intros.getByRole("button", { name: 'Edit "The wedding party"' }).click();
    await intros.getByTestId("entry-row").filter({ hasText: "The wedding party" }).getByLabel("Pronunciation guide (optional)").fill("the WED-ding PAR-tee");
    await expect(intros.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await answers(eventId, "introductions"))!.entries![1]).toMatchObject({ names: "The wedding party", pronunciation: "the WED-ding PAR-tee" });
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);

    await client.reload();
    for (const [stage, moment] of [["ceremony", "processional"], ["reception_entrance", "introductions"], ["dinner", "speeches"]]) {
      const card = await openMoment(client, stage, moment);
      await card.getByRole("button", { name: /^Edit / }).first().click();
    }
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    expect(await contractualState(eventId)).toBe(contractual);
  });
});
