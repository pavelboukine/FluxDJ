/**
 * Participants, pronunciation guides, MC and speeches in a real browser
 * against local Supabase, inside a dedicated test tenant with a booked
 * wedding (booking set up through the database functions the app calls; see
 * booking.ts). Everything about people goes through the UI:
 *   - Processional lists who walks in, in order (people or groups, either
 *     partner included), each with a song chosen or typed right there;
 *     shared songs, changes, reordering and removals; no pronunciation guide
 *     (older ones kept for staff); plans with a Couple entrance still link it;
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

  test("Processional: everyone in walking order, each with a song chosen or typed right there; shared, changed, reordered and removed safely", async () => {
    const card = await openMoment(client, "ceremony", "processional");
    await expect(card).toContainText("Add everyone who will walk down the aisle, in the order they'll enter.");
    const people = card.getByTestId("processional-participants");
    const add = people.getByTestId("processional-people-add");
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByRole("button", { name: "Add", exact: true }).click(); // a name is needed first
      await expect(form).toContainText("Enter the name or names.");
      // Nobody is announced while walking in: no pronunciation guide here.
      await expect(form.getByLabel("Pronunciation guide (optional)")).toHaveCount(0);
      await form.getByLabel("Name or names").fill("Groom and his mother");
      await form.getByLabel("Song they walk in to").selectOption({ label: "Enter a new song…" });
      await form.getByLabel("Song title").fill("Canon in D");
      await form.getByLabel("Artist", { exact: true }).fill("Pachelbel");
      await form.getByLabel("Playback instructions (optional)").fill("Start at 0:10");
    });
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Bridesmaids");
      await form.getByLabel("Song they walk in to").selectOption({ label: "Canon in D by Pachelbel" });
      await expect(form).toContainText("Also walking to this song: Groom and his mother.");
      await form.getByLabel("Instructions for the DJ (optional)").fill("Keep the same song playing");
    });
    // An unfinished new song is pointed at; nothing is added half-done.
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Flower girl");
      await form.getByLabel("Song they walk in to").selectOption({ label: "Enter a new song…" });
      await form.getByLabel("Song title").fill("A Thousand Years");
      await form.getByRole("button", { name: "Add", exact: true }).click();
      await expect(form).toContainText('Enter the song\'s title and artist, or choose "No song yet".');
      await form.getByLabel("Artist", { exact: true }).fill("Christina Perri");
    });
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Bride and her father");
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    const rows = people.getByTestId("entry-row");
    await expect(rows).toHaveText([/1\. Groom and his mother.*Song: Canon in D by Pachelbel/, /2\. Bridesmaids.*Same song as the entry above: Canon in D by Pachelbel.*Keep the same song playing/,
      /3\. Flower girl.*Song: A Thousand Years by Christina Perri/, /4\. Bride and her father.*No song chosen yet/]);
    await expect(client.getByTestId("moment-processional")).toContainText("Complete");
    let saved = (await answers(eventId, "processional"))!;
    expect(saved.songs!.map((x) => x.title)).toEqual(["Canon in D", "A Thousand Years"]);
    expect(saved.participants!.map((p) => p.song_id ?? null)).toEqual([saved.songs![0].id, saved.songs![0].id, saved.songs![1].id, null]);
    await expect(add.getByLabel("Song they walk in to")).toHaveValue("");

    // Linked songs list who walks to them and can't be removed.
    const music = card.getByTestId("music-processional");
    const canon = music.getByTestId("song-row").filter({ hasText: "Canon in D" });
    await expect(canon).toContainText("Linked to: Groom and his mother, Bridesmaids");
    await expect(canon.getByRole("button", { name: 'Remove "Canon in D"' })).toBeDisabled();

    // A listed person gets a new song with "Use this song"; until then nothing changes.
    await people.getByRole("button", { name: 'Edit "Bride and her father"' }).click();
    const bride = rows.filter({ hasText: "Bride and her father" });
    await bride.getByLabel("Song they walk in to").selectOption({ label: "Enter a new song…" });
    await bride.getByLabel("Song title").fill("Here Comes the Sun");
    await bride.getByLabel("Artist", { exact: true }).fill("The Beatles");
    await bride.getByRole("button", { name: "Use this song" }).click();
    await expect(bride).toContainText("Song: Here Comes the Sun by The Beatles");
    // Changing a song keeps the old one for everyone else.
    await people.getByRole("button", { name: 'Edit "Flower girl"' }).click();
    await rows.filter({ hasText: "Flower girl" }).getByLabel("Song they walk in to").selectOption({ label: "Canon in D by Pachelbel" });
    await expect(rows.filter({ hasText: "Flower girl" })).toContainText("Same song as the entry above: Canon in D by Pachelbel");
    // Reorder and remove.
    await people.getByRole("button", { name: 'Move "Bride and her father" up' }).click();
    await people.getByRole("button", { name: 'Remove "Bridesmaids"' }).click();
    await expect(card.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openMoment(client, "ceremony", "processional");
    await expect(again.getByTestId("processional-participants").getByTestId("entry-row")).toHaveText([
      /1\. Groom and his mother/, /2\. Bride and her father.*Here Comes the Sun/, /3\. Flower girl.*Canon in D/,
    ]);
    saved = (await answers(eventId, "processional"))!;
    // Each song once; the removed person's song stays for the others; the unused one stays listed (removable).
    expect(saved.songs!.map((x) => x.title)).toEqual(["Canon in D", "A Thousand Years", "Here Comes the Sun"]);
    expect(saved.participants!.map((p) => [p.names, saved.songs!.find((x) => x.id === p.song_id)?.title])).toEqual([
      ["Groom and his mother", "Canon in D"], ["Bride and her father", "Here Comes the Sun"], ["Flower girl", "Canon in D"],
    ]);
    const unused = again.getByTestId("music-processional").getByTestId("song-row").filter({ hasText: "A Thousand Years" });
    await expect(unused.getByRole("button", { name: 'Remove "A Thousand Years"' })).toBeEnabled();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("plans with a Couple entrance (older ones, or added by staff) still link the couple's entry to its song, which can't be removed while linked", async () => {
    // New Wedding plans have no separate Couple entrance; staff add it here as older plans have it.
    const staffDb = await sessionFor(tenant.ownerEmail);
    const { data: plan } = await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single());
    await must(staffDb.rpc("add_event_plan_item", { p_event_id: eventId, p_expected_version: plan!.structure_version, p_key: "couple_entrance", p_parent_key: "ceremony" }));
    await client.reload();
    const couple = await openMoment(client, "ceremony", "couple_entrance");
    await addSong(couple, { cue: "Couple", title: "At Last", artist: "Etta James" });
    await expect(couple.getByText("All changes saved")).toBeVisible();

    const card = await openMoment(client, "ceremony", "processional");
    const people = card.getByTestId("processional-participants");
    await addEntry(people, "processional-people-add", async (form) => {
      await form.getByLabel("Name or names").fill("Alex & Taylor");
      await form.getByLabel("Song they walk in to").selectOption({ label: "Couple: At Last by Etta James" });
    });
    await expect(card.getByText("All changes saved")).toBeVisible();
    const entry = people.getByTestId("entry-row").filter({ hasText: "Alex & Taylor" });
    await expect(entry).toContainText("Song: Couple: At Last by Etta James");

    // Linked from Processional: Couple entrance won't remove it, and says where the link is.
    const song = couple.getByTestId("song-row").filter({ hasText: "At Last" });
    await expect(song).toContainText("Linked to: Alex & Taylor");
    await expect(song.getByRole("button", { name: 'Remove "At Last"' })).toBeDisabled();
    await expect(song).toContainText("in Processional (who walks in)");
    // A rename shows through the link.
    await couple.getByRole("button", { name: 'Edit "At Last"' }).click();
    await song.getByLabel("Title", { exact: true }).fill("At Last (Live)");
    await expect(couple.getByText("All changes saved")).toBeVisible();
    await expect(entry).toContainText("Song: Couple: At Last (Live) by Etta James");

    const processional = (await answers(eventId, "processional"))!;
    const coupleSongs = (await answers(eventId, "couple_entrance"))!.songs!;
    expect(coupleSongs.map((s) => s.title)).toEqual(["At Last (Live)"]);
    expect(processional.songs!.map((s) => s.title)).toEqual(["Canon in D", "A Thousand Years", "Here Comes the Sun"]);
    expect(processional.participants!.find((p) => p.names === "Alex & Taylor")!.song_id).toBe(coupleSongs[0].id);
  });

  test("an older pronunciation guide in Processional is kept and shown to staff, never asked of the client", async () => {
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const itemId = plan!.event_plan_items.find((i) => i.key === "processional")!.id;
    const stored = (await answers(eventId, "processional"))!;
    await must(admin.from("event_plan_responses").update({
      answers: { ...stored, participants: stored.participants!.map((p, i) => (i === 0 ? { ...p, pronunciation: "GROOM-ee" } : p)) },
    }).eq("item_id", itemId));
    await client.reload();
    const card = await openMoment(client, "ceremony", "processional");
    const groom = card.getByTestId("entry-row").filter({ hasText: "Groom and his mother" });
    await expect(groom).not.toContainText("GROOM-ee");
    await card.getByRole("button", { name: 'Edit "Groom and his mother"' }).click();
    await groom.getByLabel("Instructions for the DJ (optional)").fill("Wait for the doors");
    await expect.poll(async () => (await answers(eventId, "processional"))!.participants![0]).toMatchObject({ pronunciation: "GROOM-ee", notes: "Wait for the doors" });
    await staff.goto(staffPlanningUrl);
    const staffCard = await openMoment(staff, "ceremony", "processional");
    await expect(staffCard.getByTestId("entry-row").filter({ hasText: "Groom and his mother" })).toContainText("(say: GROOM-ee)");
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
    await leo.getByRole("checkbox", { name: "Time: next day (Sun, Aug 15)" }).check();
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
