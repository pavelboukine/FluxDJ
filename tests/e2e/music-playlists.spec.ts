/**
 * Playlist links on music lists, in a real browser against local Supabase,
 * inside a dedicated test tenant with a wedding booked through Flux (see
 * booking.ts). Through the UI:
 *   - the client (phone-sized) attaches Spotify, Apple Music, YouTube Music
 *     and other https playlist links; bad, plain-http and duplicate links are
 *     refused; names and notes are edited; removal can be undone; a reload
 *     keeps everything in order; a playlist alone completes the list and
 *     blocks "DJ's choice" until removed; songs and playlists coexist;
 *   - song moments such as the first dance offer no playlists;
 *   - staff see the playlists in planning, on the web run sheet and as
 *     clickable links in the PDF; archived plans are read-only;
 *   - nothing is fetched from music services and nothing contractual changes.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { pdfLinks, pdfPageTexts } from "../support/pdf";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanMoment, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-playlists-${run}@example.test`;
const SPOTIFY = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=e2e";
const APPLE = "https://music.apple.com/ca/playlist/must-plays/pl.u-8aAVZ0lCNr4mD";
const YTM = "https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG";
const OTHER = "https://playlists.example.org/ours";

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openMoment(page: Page, stageKey: string, momentKey: string): Promise<Locator> {
  return (await openPlanMoment(page, stageKey, momentKey)).getByTestId(`music-${momentKey}`);
}

async function addPlaylist(editor: Locator, url: string, name = "") {
  const form = editor.getByTestId(/-add-playlist$/);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  await form.getByLabel("Playlist link").fill(url);
  await form.getByLabel("Playlist name (optional)").fill(name);
  await form.getByRole("button", { name: "Add playlist" }).click();
}

const cards = (editor: Locator) => editor.getByTestId("playlist-row");

async function stored(eventId: string, key: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === key)!;
  return (await admin.from("event_plan_responses").select("answers").eq("item_id", item.id).maybeSingle()).data?.answers as
    { songs?: { title: string }[]; playlists?: { id: string; url: string; label?: string; notes?: string }[]; choice?: string } | undefined;
}

test.describe.serial("playlist links in planning", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractual = "";
  let planningUrl = "";

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("playlists", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Alex Rivera", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E Playlist Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18", venue_name: "Domaine E2E",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    await bookEvent(tenant, eventId, clientEmail);
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    await client.goto(planningUrl);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the client attaches, edits and removes playlists on a phone; bad and duplicate links are refused; a reload keeps them", async () => {
    const cocktail = await openMoment(client, "cocktail", "cocktail_music");
    await expect(client.getByTestId("moment-cocktail_music")).toContainText("Not started");
    await expect(cocktail).toContainText("Have a playlist that captures the vibe you're going for?");

    // Links are checked before they join the list.
    await addPlaylist(cocktail, "open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    await expect(cocktail.getByTestId(/-add-playlist$/)).toContainText("Enter the full playlist link, starting with https://.");
    await addPlaylist(cocktail, "http://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    await expect(cocktail.getByTestId(/-add-playlist$/)).toContainText("Enter the full playlist link, starting with https://.");
    await addPlaylist(cocktail, "   ");
    await expect(cocktail.getByTestId(/-add-playlist$/)).toContainText("Paste the playlist link.");
    await expect(cards(cocktail)).toHaveCount(0);

    await addPlaylist(cocktail, SPOTIFY, "Cocktail Hour");
    await expect(cards(cocktail)).toHaveCount(1);
    await expect(cards(cocktail).first()).toContainText("Spotify playlist");
    await expect(cards(cocktail).first()).toContainText("Cocktail Hour");
    const open = cards(cocktail).first().getByRole("link", { name: /^Open playlist "Cocktail Hour"/ });
    await expect(open).toHaveAttribute("href", SPOTIFY);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-cocktail_music")).toContainText("Complete");

    // The same playlist again (other sharing code, trailing slash) is refused; another service's link is welcome.
    await addPlaylist(cocktail, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M/?si=other");
    await expect(cocktail.getByTestId(/-add-playlist$/)).toContainText("This playlist is already added here.");
    await expect(cards(cocktail)).toHaveCount(1);
    await addPlaylist(cocktail, OTHER);
    await expect(cards(cocktail)).toHaveCount(2);
    await expect(cards(cocktail).nth(1)).toContainText("Playlist link · playlists.example.org");
    await expect(cocktail.getByText("All changes saved")).toBeVisible();

    // A list with playlists can't switch to DJ's choice (nothing is removed silently).
    const djChoice = cocktail.getByRole("radio", { name: /DJ's choice: no suggestions/ });
    await expect(djChoice).toBeDisabled();
    await expect(cocktail).toContainText("Remove the songs and playlists to choose this.");

    // Edit the name and notes in place.
    await cocktail.getByRole("button", { name: 'Edit playlist "Cocktail Hour"' }).click();
    const first = cards(cocktail).first();
    await first.getByLabel("Playlist name (optional)").fill("Cocktail hour vibes");
    await first.getByLabel("Playlist notes (optional)").fill("Relaxed indie and acoustic");
    await first.getByRole("button", { name: 'Done editing playlist "Cocktail hour vibes"' }).click();
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect(first).toContainText("Notes: Relaxed indie and acoustic");

    // Remove with undo, then remove for good (Remove sits in the playlist's edit panel).
    await cocktail.getByRole("button", { name: 'Edit playlist "Playlist link"' }).click();
    await cocktail.getByRole("button", { name: 'Remove playlist "Playlist link"' }).click();
    await expect(cards(cocktail)).toHaveCount(1);
    await cocktail.getByRole("button", { name: "Undo" }).click();
    await expect(cards(cocktail)).toHaveCount(2);
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await cocktail.getByRole("button", { name: 'Edit playlist "Playlist link"' }).click();
    await cocktail.getByRole("button", { name: 'Remove playlist "Playlist link"' }).click();
    await expect(cards(cocktail)).toHaveCount(1);
    await expect(cocktail.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await stored(eventId, "cocktail_music"))?.playlists?.map((p) => [p.url, p.label, p.notes]))
      .toEqual([[SPOTIFY, "Cocktail hour vibes", "Relaxed indie and acoustic"]]);

    // Must play: a playlist and a song side by side.
    const mustPlay = await openMoment(client, "party", "must_play");
    await expect(mustPlay).toContainText("Have songs you absolutely want to hear?");
    await addPlaylist(mustPlay, APPLE, "Dance floor");
    await expect(cards(mustPlay).first()).toContainText("Apple Music playlist");
    const addSong = mustPlay.getByTestId(/-add$/);
    await addSong.locator("summary").click();
    await addSong.getByLabel("Title", { exact: true }).fill("September");
    await addSong.getByLabel("Artist", { exact: true }).fill("Earth, Wind & Fire");
    await addSong.getByRole("button", { name: "Add song" }).click();
    await expect(mustPlay.getByTestId("song-row")).toHaveCount(1);
    await expect(mustPlay.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-must_play")).toContainText("Complete");
    // On a phone every song and playlist action, and the "Add a song" disclosure itself (its <summary>,
    // not the card around it), is a 44px touch target, and no two overlap.
    const addSongToggle = mustPlay.getByTestId(/-add$/).locator("summary");
    await expect(addSongToggle).toHaveText("Add a song");
    const boxes = await Promise.all((await mustPlay.locator("[data-testid=song-row] button, [data-testid=playlist-row] a, [data-testid=playlist-row] button").all()).map((b) => b.boundingBox()));
    // Rows show reorder and Edit (Remove sits in the edit panel): a song's up, down and Edit, a playlist's Open and Edit.
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    boxes.push(await addSongToggle.boundingBox());
    for (const b of boxes) expect(Math.min(b!.width, b!.height)).toBeGreaterThanOrEqual(44);
    const overlaps = boxes.some((a, i) => boxes.some((b, j) => i < j && a!.x < b!.x + b!.width && b!.x < a!.x + a!.width && a!.y < b!.y + b!.height && b!.y < a!.y + a!.height));
    expect(overlaps).toBe(false);

    // Do not play: a YouTube Music playlist alone answers it.
    const dnp = await openMoment(client, "party", "do_not_play");
    await addPlaylist(dnp, YTM, "Please avoid");
    await expect(cards(dnp).first()).toContainText("YouTube Music playlist");
    await expect(dnp.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("moment-do_not_play")).toContainText("Complete");
    expect(await noSideways(client)).toBe(0);

    // Song moments take songs only.
    const firstDance = await openMoment(client, "special_dances", "first_dance");
    await expect(firstDance.getByTestId(/-add-playlist$/)).toHaveCount(0);
    await expect(firstDance).not.toContainText("playlist");
    await expect(firstDance).toContainText("Still needed: Songs or a choice");
    // Lists that take playlists say so while they still need an answer (Do not play is complete by now).
    await expect(await openMoment(client, "party", "play_if_possible")).toContainText("Still needed: Songs, playlists or a choice");

    // A reload keeps every playlist, in order, with its name and notes.
    await client.reload();
    const again = await openMoment(client, "cocktail", "cocktail_music");
    await expect(cards(again)).toHaveCount(1);
    await expect(cards(again).first()).toContainText("Cocktail hour vibes");
    await expect(cards(again).first()).toContainText("Notes: Relaxed indie and acoustic");
    const must = await stored(eventId, "must_play");
    expect([must?.playlists?.map((p) => p.url), must?.songs?.map((s) => s.title)]).toEqual([[APPLE], ["September"]]);
  });

  test("staff see the playlists in planning, on the web run sheet and as links in the PDF; archived plans are read-only", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning`);
    const cocktail = await openMoment(staff, "cocktail", "cocktail_music");
    await expect(cards(cocktail).first()).toContainText("Cocktail hour vibes");
    await expect(cards(cocktail).first().getByRole("link", { name: /^Open playlist/ })).toHaveAttribute("href", SPOTIFY);

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/run-sheet`);
    const list = staff.getByTestId("run-list-cocktail_music");
    await expect(list).toContainText("(1 playlist)");
    await list.locator("summary").click();
    const item = list.getByTestId("run-playlist");
    await expect(item).toContainText("Spotify playlist: Cocktail hour vibes");
    await expect(item).toContainText("Notes: Relaxed indie and acoustic");
    const link = item.getByRole("link", { name: "Open playlist: Cocktail hour vibes" });
    await expect(link).toHaveAttribute("href", SPOTIFY);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(staff.getByTestId("run-list-do_not_play").getByTestId("run-playlist")).toContainText("YouTube Music playlist: Please avoid");
    await expect(staff.getByText("1 playlist: see the full list in Music lists")).toBeVisible();
    await expect(staff.getByText("1 playlist and 1 song: see the full list in Music lists")).toBeVisible();
    await expect(staff.locator("body")).not.toContainText("37i9dQZF1DXcBWIGoYBM5M");

    const download = staff.waitForEvent("download");
    await staff.getByRole("link", { name: "Download run sheet PDF" }).click();
    const bytes = readFileSync((await (await download).path())!);
    const text = (await pdfPageTexts(bytes)).join("\n");
    expect(text).toContain("Spotify playlist: Cocktail hour vibes");
    expect(text).toContain("Apple Music playlist: Dance floor");
    const links = await pdfLinks(bytes);
    for (const url of [SPOTIFY, APPLE, YTM]) expect(links).toContain(url);

    // Archived: staff see the links but can't change them.
    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", eventId));
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning`);
    const readOnly = await openMoment(staff, "cocktail", "cocktail_music");
    await expect(cards(readOnly).first().getByRole("link", { name: /^Open playlist/ })).toBeVisible();
    await expect(readOnly.getByRole("button", { name: /Edit playlist|Remove playlist|Add playlist/ })).toHaveCount(0);
    await must(admin.from("events").update({ archived_at: null }).eq("id", eventId));

    expect(await contractualState(eventId)).toBe(contractual);
  });
});
