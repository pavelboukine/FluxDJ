/**
 * Participants, pronunciation guides, MC and speeches in a real browser
 * against local Supabase, inside a dedicated test tenant with a booked
 * wedding (booking set up through the database functions the app calls; see
 * booking.ts). Everything about people goes through the UI:
 *   - Processional lists who walks in, in order (people or groups, either
 *     partner included), each with a song chosen or typed right there;
 *     shared songs, changes, reordering and removals; no pronunciation guide
 *     (older ones kept for staff); plans with a Couple entrance still link it;
 *   - the reception's grand entrance: a Yes / No / Not sure decision that
 *     shows or sets aside its time and order without clearing them; guest
 *     entry stays separate; the order lists who is introduced, with an
 *     optional pronunciation and announcement and a song chosen or typed
 *     right there (shared, changed, reordered, removed safely); older plans'
 *     Entrance music still links, and a linked song can't be removed (also
 *     from a stale tab);
 *   - the MC: four choices, shared duties with the other MC's name, the
 *     DJ's configured name, legacy No MC and pronunciation answers kept;
 *   - speeches (exact time with next day, cue, undecided);
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
    entries?: { id: string; names?: string; speaker?: string; song_id?: string; music?: string; timing?: string; time?: string; next_day?: boolean; cue?: string }[];
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
    // The same song details as the songs list: a version and a link (checked before it joins the list).
    await bride.getByLabel("Version (optional)").fill("2019 mix");
    await bride.getByLabel("Song link (optional)").fill("open.spotify.com/track/6dGnYIeXmHdcikdzNNDMm2");
    await bride.getByRole("button", { name: "Use this song" }).click();
    await expect(bride).toContainText("Enter a full https:// address, or leave the link empty.");
    await bride.getByLabel("Song link (optional)").fill("https://open.spotify.com/track/6dGnYIeXmHdcikdzNNDMm2");
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
    expect(saved.songs![2]).toMatchObject({ version: "2019 mix", link: "https://open.spotify.com/track/6dGnYIeXmHdcikdzNNDMm2" });
    await expect(again.getByTestId("music-processional").getByTestId("song-row").filter({ hasText: "Here Comes the Sun" })).toContainText("Open link (open.spotify.com)");
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

  test("the grand entrance decision: Yes shows its time and order, No and Not sure set them aside keeping everything; guest entry stays separate", async () => {
    const reception = await openPlanSection(client, "reception_entrance");
    const details = reception.getByTestId("details-reception_entrance");
    const order = reception.getByTestId("moment-introductions");
    // Nothing decided yet: the order waits for the decision; the old Participants and Entrance music aren't in new Wedding plans.
    await expect(order).toBeHidden();
    await expect(reception.getByTestId("moment-entrance_music")).toHaveCount(0);
    await expect(reception).not.toContainText("Participants and names");
    await expect(details.getByLabel("Planned grand entrance time (needed)")).toHaveCount(0);
    await expect(details).toContainText("Formal grand entrance");
    // Guest entry and the reception area are independent, and optional.
    await details.getByLabel("When will guests enter the reception space? (needed)").fill("17:45");
    await expect(details.getByLabel("Where will the reception take place? (optional)")).toHaveAttribute("placeholder", "Main hall, tent, or dinner area");

    await details.getByLabel("Yes, we're planning a grand entrance").check();
    await expect(order).toBeVisible();
    // A planned entrance needs its time: it's named as still needed until it's in.
    await expect(details.getByTestId("item-needs")).toContainText("Planned grand entrance time");
    await details.getByLabel("Planned grand entrance time (needed)").fill("18:15");
    await expect(reception.getByText("All changes saved").first()).toBeVisible();
    await expect.poll(async () => answers(eventId, "reception_entrance")).toEqual({ guest_entry_time: "17:45", grand_entrance: "planned", entrance_time: "18:15" });
    await expect(reception.getByTestId("details-status")).toContainText("Complete");
    await expect(details.getByTestId("item-needs")).toHaveCount(0);

    // No: the time and the order step aside; what was entered is kept.
    await details.getByLabel("No, we'll skip the formal entrance").check();
    await expect(order).toBeHidden();
    await expect(details.getByLabel("Planned grand entrance time (needed)")).toHaveCount(0);
    await expect(details.getByTestId("grand-entrance-kept")).toBeVisible();
    await expect.poll(async () => answers(eventId, "reception_entrance")).toEqual({ guest_entry_time: "17:45", grand_entrance: "none", entrance_time: "18:15" });
    await expect(reception.getByTestId("details-status")).toContainText("Complete");
    // Not sure yet: stays open, never treated as yes or no.
    await details.getByLabel("We're not sure yet").check();
    await expect(order).toBeHidden();
    await expect(details).toContainText("Not decided yet");
    await expect.poll(async () => (await answers(eventId, "reception_entrance"))!.grand_entrance).toBe("undecided");
    // Yes again: the time is back as entered.
    await details.getByLabel("Yes, we're planning a grand entrance").check();
    await expect(details.getByLabel("Planned grand entrance time (needed)")).toHaveValue("18:15");
    await expect(order).toBeVisible();
    await expect.poll(async () => (await answers(eventId, "reception_entrance"))!.grand_entrance).toBe("planned");
    await client.reload();
    const again = await openPlanSection(client, "reception_entrance");
    await expect(again.getByTestId("details-reception_entrance").getByLabel("Yes, we're planning a grand entrance")).toBeChecked();
    await expect(again.getByTestId("details-reception_entrance").getByLabel("Planned grand entrance time (needed)")).toHaveValue("18:15");
    await expect(again.getByTestId("details-reception_entrance").getByLabel("When will guests enter the reception space? (needed)")).toHaveValue("17:45");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("the grand entrance order: each person or group with how to announce them and a song chosen or typed right there; shared, changed, reordered, removed", async () => {
    let intros = await openMoment(client, "reception_entrance", "introductions");
    await expect(intros).toContainText("Grand entrance order");
    await addEntry(intros, "introductions-entries-add", async (form) => {
      await form.getByLabel("Names exactly as announced").fill("Bridesmaids");
      await form.getByLabel("How should they be announced? (optional)").fill("Let's welcome the bridesmaids!");
      // Music is decided explicitly: new entries start as "Not decided yet".
      await expect(form.getByLabel("Not decided yet")).toBeChecked();
      await expect(form.getByLabel("Song they enter to")).toHaveCount(0);
      await form.getByLabel("Choose a song").check();
      await form.getByLabel("Song they enter to").selectOption({ label: "Enter a new song…" });
      await form.getByLabel("Song title").fill("Man! I Feel Like a Woman!");
      await form.getByLabel("Artist", { exact: true }).fill("Shania Twain");
      await form.getByLabel("Playback instructions (optional)").fill("Start at the chorus");
    });
    await addEntry(intros, "introductions-entries-add", async (form) => {
      await form.getByLabel("Names exactly as announced").fill("The wedding party");
      await form.getByLabel("Choose a song").check();
      await form.getByLabel("Song they enter to").selectOption({ label: "Man! I Feel Like a Woman! by Shania Twain" });
      await expect(form).toContainText("Also entering to this song: Bridesmaids.");
      await form.getByLabel("Instructions for the DJ or MC (optional)").fill("Keep the same song playing");
    });
    await addEntry(intros, "introductions-entries-add", async (form) => {
      await form.getByLabel("Names exactly as announced").fill("Alex and Taylor Nguyen-Roy");
      await form.getByLabel("Name pronunciation (optional)").fill("NWEN-rwah");
      await form.getByLabel("How should they be announced? (optional)").fill("For the first time as a married couple");
      await form.getByLabel("Choose a song").check();
      await form.getByLabel("Song they enter to").selectOption({ label: "Enter a new song…" });
      await form.getByLabel("Song title").fill("Feel So Close");
      await form.getByLabel("Artist", { exact: true }).fill("Calvin Harris");
    });
    // A doubled click on Add adds nothing twice.
    await addEntry(intros, "introductions-entries-add", async (form) => {
      await form.getByLabel("Names exactly as announced").fill("Our parents");
      await form.getByRole("button", { name: "Add", exact: true }).click();
    });
    await expect(intros.getByText("All changes saved")).toBeVisible();
    let rows = intros.getByTestId("entry-row");
    await expect(rows).toHaveText([
      /1\. Bridesmaids.*Announcement: Let's welcome the bridesmaids!.*Song: Man! I Feel Like a Woman! by Shania Twain/,
      /2\. The wedding party.*Same song as the entry above: Man! I Feel Like a Woman!.*Keep the same song playing/,
      /3\. Alex and Taylor Nguyen-Roy \(say: NWEN-rwah\).*Song: Feel So Close by Calvin Harris/,
      /4\. Our parents.*Music not decided yet/,
    ]);
    let saved = (await answers(eventId, "introductions"))!;
    expect(saved.songs!.map((s) => s.title)).toEqual(["Man! I Feel Like a Woman!", "Feel So Close"]);
    expect(saved.entries!.map((e) => e.song_id ?? null)).toEqual([saved.songs![0].id, saved.songs![0].id, saved.songs![1].id, null]);
    // Not decided yet stays open; the DJ's choice resolves it, stored and kept on reload.
    await expect(client.getByTestId("moment-introductions")).toContainText("In progress");
    await expect(intros).toContainText("Someone's music isn't decided yet");
    await intros.getByRole("button", { name: 'Edit "Our parents"' }).click();
    await rows.filter({ hasText: "Our parents" }).getByLabel("DJ's choice").check();
    await expect(rows.filter({ hasText: "Our parents" })).toContainText("Music: DJ's choice");
    await expect.poll(async () => (await answers(eventId, "introductions"))!.entries![3]).toEqual({ id: saved.entries![3].id, names: "Our parents", music: "dj_choice" });
    await expect(client.getByTestId("moment-introductions")).toContainText("Complete");
    await client.reload();
    intros = await openMoment(client, "reception_entrance", "introductions");
    rows = intros.getByTestId("entry-row");
    await expect(rows.filter({ hasText: "Our parents" })).toContainText("Music: DJ's choice");
    await intros.getByRole("button", { name: 'Edit "Our parents"' }).click();
    await expect(rows.filter({ hasText: "Our parents" }).getByLabel("DJ's choice")).toBeChecked();
    await intros.getByRole("button", { name: 'Done editing "Our parents"' }).click();
    // Song -> DJ's choice -> Not decided -> Song: the shared song stays with the others, and comes back.
    await intros.getByRole("button", { name: 'Edit "The wedding party"' }).click();
    const party = rows.filter({ hasText: "The wedding party" });
    await party.getByLabel("DJ's choice").check();
    await expect(party).toContainText("Music: DJ's choice");
    await expect(intros.getByTestId("music-introductions").getByTestId("song-row").filter({ hasText: "Man! I Feel Like a Woman!" })).toContainText("Linked to: Bridesmaids");
    await party.getByLabel("Not decided yet").check();
    await expect(party).toContainText("Music not decided yet");
    await party.getByLabel("Choose a song").check();
    await expect(party.getByLabel("Song they enter to")).toHaveValue(saved.songs![0].id);
    await expect.poll(async () => (await answers(eventId, "introductions"))!.entries![1].song_id).toBe(saved.songs![0].id);
    await intros.getByRole("button", { name: 'Done editing "The wedding party"' }).click();
    // Linked songs list who enters to them and can't be removed.
    const shania = intros.getByTestId("music-introductions").getByTestId("song-row").filter({ hasText: "Man! I Feel Like a Woman!" });
    await expect(shania).toContainText("Linked to: Bridesmaids, The wedding party");
    await expect(shania.getByRole("button", { name: 'Remove "Man! I Feel Like a Woman!"' })).toBeDisabled();

    // A listed entry gets a new song with "Use this song", and pronunciation is edited in place.
    await intros.getByRole("button", { name: 'Edit "Our parents"' }).click();
    const parents = rows.filter({ hasText: "Our parents" });
    await parents.getByLabel("Name pronunciation (optional)").fill("our PAIR-ents");
    await parents.getByLabel("Choose a song").check(); // DJ's choice -> a new song
    await parents.getByLabel("Song they enter to").selectOption({ label: "Enter a new song…" });
    await parents.getByLabel("Song title").fill("September");
    await parents.getByLabel("Artist", { exact: true }).fill("Earth, Wind & Fire");
    await parents.getByLabel("Song link (optional)").fill("https://www.youtube.com/watch?v=Gs069dndIYk");
    await parents.getByRole("button", { name: "Use this song" }).click();
    await parents.getByRole("button", { name: "Use this song" }).click({ timeout: 1000 }).catch(() => {}); // a doubled click
    await expect(parents).toContainText("Song: September by Earth, Wind & Fire");
    // Changing a song keeps it for everyone else; reorder and remove.
    await intros.getByRole("button", { name: 'Edit "The wedding party"' }).click();
    await rows.filter({ hasText: "The wedding party" }).getByLabel("Song they enter to").selectOption({ label: "Feel So Close by Calvin Harris" });
    await intros.getByRole("button", { name: 'Move "Our parents" up' }).click();
    await intros.getByRole("button", { name: 'Remove "Bridesmaids"' }).click();
    await expect(intros.getByText("All changes saved")).toBeVisible();

    await client.reload();
    const again = await openMoment(client, "reception_entrance", "introductions");
    await expect(again.getByTestId("entry-row")).toHaveText([
      /1\. The wedding party.*Feel So Close/, /2\. Our parents \(say: our PAIR-ents\).*September/, /3\. Alex and Taylor Nguyen-Roy.*Song: Feel So Close/,
    ]);
    saved = (await answers(eventId, "introductions"))!;
    // Each song once, none lost or doubled; the removed entry's song stays listed (now removable).
    expect(saved.songs!.map((s) => s.title)).toEqual(["Man! I Feel Like a Woman!", "Feel So Close", "September"]);
    expect(saved.songs![2]).toMatchObject({ link: "https://www.youtube.com/watch?v=Gs069dndIYk" });
    expect(saved.entries!.map((e) => [e.names, saved.songs!.find((s) => s.id === e.song_id)?.title])).toEqual([
      ["The wedding party", "Feel So Close"], ["Our parents", "September"], ["Alex and Taylor Nguyen-Roy", "Feel So Close"],
    ]);
    await expect(again.getByTestId("music-introductions").getByTestId("song-row").filter({ hasText: "Man! I Feel Like a Woman!" })
      .getByRole("button", { name: 'Remove "Man! I Feel Like a Woman!"' })).toBeEnabled();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("plans with Entrance music (older ones, or added by staff) still link to it; a linked song can't be removed, even from a stale tab", async () => {
    const staffDb = await sessionFor(tenant.ownerEmail);
    const { data: plan } = await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single());
    await must(staffDb.rpc("add_event_plan_item", { p_event_id: eventId, p_expected_version: plan!.structure_version, p_key: "entrance_music", p_parent_key: "reception_entrance" }));
    await client.reload();
    const entrance = await openMoment(client, "reception_entrance", "entrance_music");
    await addSong(entrance, { cue: "Couple", title: "Signed, Sealed, Delivered", artist: "Stevie Wonder" });
    await expect(entrance.getByText("All changes saved")).toBeVisible();
    // A second tab opened before the link exists.
    const stale = await clientContext.newPage();
    await stale.goto(planningUrl);
    const staleEntrance = await openMoment(stale, "reception_entrance", "entrance_music");

    const intros = await openMoment(client, "reception_entrance", "introductions");
    await intros.getByRole("button", { name: 'Edit "Alex and Taylor Nguyen-Roy"' }).click();
    await intros.getByTestId("entry-row").filter({ hasText: "Alex and Taylor" }).getByLabel("Song they enter to").selectOption({ label: "Couple: Signed, Sealed, Delivered by Stevie Wonder" });
    await expect(intros.getByText("All changes saved")).toBeVisible();
    const music = (await answers(eventId, "entrance_music"))!.songs!;
    expect((await answers(eventId, "introductions"))!.entries![2].song_id).toBe(music[0].id);

    await staleEntrance.getByRole("button", { name: 'Remove "Signed, Sealed, Delivered"' }).click();
    await expect(staleEntrance.getByRole("alert").filter({ hasText: "linked to introductions" })).toHaveText(
      '"Signed, Sealed, Delivered" is linked to introductions (Alex and Taylor Nguyen-Roy). Change those introductions first. Use Undo to put the song back.',
    );
    await staleEntrance.getByRole("button", { name: "Undo" }).click();
    await expect(staleEntrance.getByText("All changes saved")).toBeVisible();
    await stale.close();
    expect((await answers(eventId, "entrance_music"))!.songs!.map((s) => s.title)).toEqual(["Signed, Sealed, Delivered"]);
    // Choosing No hides Entrance music as well; Yes brings both back as saved.
    const details = (await openPlanSection(client, "reception_entrance")).getByTestId("details-reception_entrance");
    await details.getByLabel("No, we'll skip the formal entrance").check();
    await expect(client.getByTestId("moment-entrance_music")).toBeHidden();
    await details.getByLabel("Yes, we're planning a grand entrance").check();
    await expect(client.getByTestId("moment-entrance_music")).toBeVisible();
    await expect.poll(async () => (await answers(eventId, "reception_entrance"))!.grand_entrance).toBe("planned");
  });

  test("the MC: four choices with a generic DJ; another MC's name is needed when someone else or both handle it; no pronunciation asked", async () => {
    const mc = await openMoment(client, "reception_entrance", "mc");
    await expect(mc).toContainText("Who will handle MC duties during the reception? (needed)");
    await expect(mc.getByRole("radio")).toHaveCount(4);
    for (const label of ["Your DJ will be the MC", "Someone else will be the MC", "Your DJ and another MC will share duties", "Not sure yet — discuss with your DJ"]) {
      await expect(mc.getByLabel(label, { exact: true })).toBeVisible();
    }
    // No DJ name is configured: never the business name, and "No MC" is no longer offered.
    await expect(mc).not.toContainText(tenant.displayName);
    await expect(mc.getByLabel("No MC")).toHaveCount(0);

    await mc.getByLabel("Someone else will be the MC").check();
    await expect(client.getByTestId("moment-mc")).toContainText("In progress");
    await expect(mc.getByLabel("Pronunciation guide (optional)")).toHaveCount(0);
    await mc.getByLabel("MC's name (needed)").fill("Kiara Okafor");
    await mc.getByLabel("Phone or email (optional)").fill("kiara@example.test");
    await mc.getByLabel("Instructions (optional)").fill("Bilingual announcements");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-mc")).toContainText("Complete");
    expect(await answers(eventId, "mc")).toEqual({ mc: "other", name: "Kiara Okafor", contact: "kiara@example.test", notes: "Bilingual announcements" });

    // Shared duties keep the other MC's details, and need the name.
    await mc.getByLabel("Your DJ and another MC will share duties").check();
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "shared", name: "Kiara Okafor", contact: "kiara@example.test", notes: "Bilingual announcements" });
    await mc.getByLabel("MC's name (needed)").fill("");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-mc")).toContainText("In progress");
    await mc.getByLabel("MC's name (needed)").fill("Kiara Okafor");
    await expect(client.getByTestId("moment-mc")).toContainText("Complete");

    await mc.getByLabel("Your DJ will be the MC").check();
    await expect(mc.getByLabel("MC's name (needed)")).toHaveCount(0);
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "dj", notes: "Bilingual announcements" });

    await mc.getByLabel("Not sure yet — discuss with your DJ").check();
    await expect(mc.getByText("All changes saved")).toBeVisible();
    await expect(mc.getByTestId("item-needs")).toContainText("To discuss with your DJ:");
    await expect(mc.locator("summary").first()).toContainText("To discuss with your DJ");
    await client.reload();
    const reloaded = await openMoment(client, "reception_entrance", "mc");
    await expect(reloaded.getByLabel("Not sure yet — discuss with your DJ")).toBeChecked();
    expect(await answers(eventId, "mc")).toEqual({ mc: "discuss", notes: "Bilingual announcements" });
  });

  test("the DJ named in the MC choices is the event's DJ, else the business's DJ name", async () => {
    await must(admin.from("tenants").update({ dj_name: "DJ Boukine E2E" }).eq("id", tenant.id));
    try {
      await client.reload();
      let mc = await openMoment(client, "reception_entrance", "mc");
      await expect(mc.getByLabel("DJ Boukine E2E (your DJ) will be the MC")).toBeVisible();
      await expect(mc.getByLabel("DJ Boukine E2E (your DJ) and another MC will share duties")).toBeVisible();
      // Generic choices still say "your DJ".
      await expect(mc.getByLabel("Not sure yet — discuss with your DJ")).toBeVisible();

      await must(admin.from("events").update({ dj_name: "DJ Sam E2E" }).eq("id", eventId));
      await client.reload();
      mc = await openMoment(client, "reception_entrance", "mc");
      await expect(mc.getByLabel("DJ Sam E2E (your DJ) will be the MC")).toBeVisible();
      await expect(mc).not.toContainText("DJ Boukine E2E");
      await staff.goto(staffPlanningUrl);
      const staffMc = await openMoment(staff, "reception_entrance", "mc");
      await expect(staffMc.getByLabel("DJ Sam E2E (the DJ) will be the MC")).toBeVisible();
      await expect(staffMc.getByLabel("Not sure yet — discuss with the DJ")).toBeChecked();
    } finally {
      await must(admin.from("events").update({ dj_name: null }).eq("id", eventId));
      await must(admin.from("tenants").update({ dj_name: null }).eq("id", tenant.id));
    }
  });

  test("a saved No MC answer and an earlier pronunciation guide stay as saved, readable and safely updatable", async () => {
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const itemId = plan!.event_plan_items.find((i) => i.key === "mc")!.id;
    await must(admin.from("event_plan_responses").update({ answers: { mc: "none", notes: "No announcements" } }).eq("item_id", itemId));
    await client.reload();
    let mc = await openMoment(client, "reception_entrance", "mc");
    await expect(mc.getByLabel("No MC")).toBeChecked();
    await expect(mc).toContainText("An earlier answer that is no longer offered.");
    // Still answered: "No MC" means the moment needs nothing, so the row reads not applicable (never "not started").
    await expect(client.getByTestId("moment-mc").locator("summary").first()).toContainText("Not applicable");
    await expect(client.getByTestId("moment-mc").locator("summary").first()).toContainText("No MC");
    await mc.getByLabel("Instructions (optional)").fill("No announcements, please");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "none", notes: "No announcements, please" });
    await mc.getByLabel("Someone else will be the MC").check();
    await mc.getByLabel("MC's name (needed)").fill("Kiara Okafor");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "other", name: "Kiara Okafor", notes: "No announcements, please" });

    // An earlier pronunciation guide: kept when the client edits, shown to staff only.
    await must(admin.from("event_plan_responses").update({ answers: { mc: "other", name: "Kiara Okafor", pronunciation: "kee-AR-ah" } }).eq("item_id", itemId));
    await client.reload();
    mc = await openMoment(client, "reception_entrance", "mc");
    await expect(mc).not.toContainText("kee-AR-ah");
    await expect(mc.getByLabel("No MC")).toHaveCount(0);
    await mc.getByLabel("Phone or email (optional)").fill("kiara@example.test");
    await expect(mc.getByText("All changes saved")).toBeVisible();
    expect(await answers(eventId, "mc")).toEqual({ mc: "other", name: "Kiara Okafor", pronunciation: "kee-AR-ah", contact: "kiara@example.test" });
    await staff.goto(staffPlanningUrl);
    const staffMc = await openMoment(staff, "reception_entrance", "mc");
    await expect(staffMc.getByTestId("mc-earlier-pronunciation")).toContainText("kee-AR-ah");
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
    await expect(card.locator("summary").first()).toContainText("Complete");
    await expect(card.getByTestId("item-needs")).toHaveCount(0);
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
    await intros.getByTestId("entry-row").filter({ hasText: "The wedding party" }).getByLabel("Name pronunciation (optional)").fill("the WED-ding PAR-tee");
    await expect(intros.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await answers(eventId, "introductions"))!.entries![0]).toMatchObject({ names: "The wedding party", pronunciation: "the WED-ding PAR-tee" });
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
