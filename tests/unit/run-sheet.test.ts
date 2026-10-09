import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRunSheet, whenText, type RunSheet } from "@/lib/run-sheet/model";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { runSheetFileName } from "@/lib/run-sheet/load.server";
import { pdfPageTexts, rasterizePdf } from "../support/pdf";
import { id, input, planView, song } from "./fixtures/run-sheet";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const titles = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => song(`${prefix} chanson ${i + 1} – « Été indien »`, `Artiste Québécois ${i + 1}`, i % 7 === 0 ? { version: "Radio edit", notes: "Pour le souper" } : {}));

// A detailed wedding: reuse, links, cues, overnight times, French and long text.
const contactId = id();
const songA = song("Canon in D", "Johann Pachelbel", { cue: "Grands-parents", version: "String quartet" });
const songB = song("A Thousand Years", "Christina Perri", { cue: "Demoiselles d'honneur" });
const coupleSong = song("La vie en rose", "Édith Piaf", { notes: "Start at 0:20, fade at the second chorus" });
const entranceX = song("September", "Earth, Wind & Fire", { cue: "Parents" });
const entranceY = song("Uptown Funk", "Mark Ronson ft. Bruno Mars", { cue: "Cortège" });
const entranceZ = song("Crazy in Love", "Beyoncé", { cue: "Couple", version: "Clean" });
const entranceW = song("Unused intro", "Somebody", {});
const banned = song("Chicken Dance", "Werner Thomas");
const mustPlay = [...titles(58, "Party"), song("chicken  dance", "werner thomas")];

const wedding = planView({
  basics: {
    guest_count: 180, start_time: "15:00", end_time: "01:00", venue_room: "Salle Papineau",
    access_notes: "Quai de chargement à l'arrière (porte 4).\nAscenseur de service jusqu'au 2e étage.\nStationnement réservé : places 12 et 13.",
    announcement_language: "bilingual",
  },
  general: [
    { key: "contacts_vendors", editor: "contacts", label: "Contacts and vendors", answers: {
      day_of_source: "event_contact", day_of_client_id: contactId, day_of_phone: "+1 819 555-0142",
      vendors: [
        { id: id(), role: "photographer", name: "Marie-Ève Tremblay-Bouchard", business: "Studio Lumière d'Outaouais", phone: "819 555-0110", email: "photo@lumiere.example.test", notes: "Needs a heads-up 5 minutes before the first dance." },
        { id: id(), role: "planner", business: "Événements Parfaits" },
      ],
    } },
    { key: "dj_preferences", editor: "preferences", label: "DJ expectations", answers: { lyrics: "clean", requests: "welcome", interaction: "occasional", notes: "Pas de micro ouvert pendant le souper." } },
  ],
  eventContacts: [{ id: contactId, name: "Chloé Gagnon", phone: "+1 819 555-0101", primary: true }],
  stages: [
    { key: "arrival", editor: null, label: "Guest arrival", disabled: true, moments: [{ key: "arrival_details", editor: "arrival", label: "Arrival details", answers: { welcome: "HIDDEN STAGE TEXT" } }] },
    { key: "ceremony", editor: "stage_ceremony", label: "Cérémonie", answers: {
      location_source: "other", location_other: "Chapelle Sainte-Anne-de-Bellevue", location_area: "Jardin des roses",
      guest_arrival_time: "15:30", start_time: "16:00", end_time: "16:40", officiant_name: "Père Jean-François Létourneau", officiant_contact: "819 555-0177",
      microphones: "needed", microphone_notes: "Officiant, two readers and the vows",
      instructions: "Lower the music when the officiant raises a hand.\nNo music during the vows.",
    }, moments: [
      { key: "ceremony_details", editor: "stage_details", label: "Ceremony details" },
      { key: "pre_ceremony_music", editor: "music_background", label: "Pre-ceremony music", answers: { songs: titles(30, "Accueil") } },
      { key: "processional", editor: "processional", label: "Processional", answers: {
        songs: [songA, songB],
        participants: [
          { id: id(), names: "Grand-maman Thérèse et grand-papa Réjean", pronunciation: "tay-REZ, ray-ZHAN", song_id: songA.id },
          { id: id(), names: "Anne-Sophie Desjardins-Ouellette", pronunciation: "ahn so-FEE day-zhar-DAN oo-eh-LET", role: "Demoiselle d'honneur", song_id: songB.id },
          { id: id(), names: "Gabrielle Nguyễn", pronunciation: "gah-bree-EL NWEN", role: "Demoiselle d'honneur", song_id: songB.id },
          { id: id(), names: "Chloé & François", song_id: coupleSong.id },
        ],
      } },
      { key: "couple_entrance", editor: "moment_songs", label: "Couple entrance", answers: { songs: [coupleSong] } },
      { key: "ceremony_signing", editor: "moment_songs", label: "Signing", answers: { choice: "dj_choice" } },
      { key: "recessional", editor: "moment_songs", label: "Recessional", answers: { songs: [song("Signed, Sealed, Delivered", "Stevie Wonder")] } },
    ] },
    { key: "cocktail", editor: "stage_cocktail", label: "Cocktail", answers: { location_source: "event_venue", location_area: "Terrasse", start_time: "16:45", end_time: "18:00", atmosphere: "Jazz manouche" }, moments: [
      { key: "cocktail_music", editor: "music_background", label: "Background music", answers: { choice: "dj_choice" } },
    ] },
    { key: "reception_entrance", editor: "stage_entrance", label: "Reception entrance", answers: { guest_entry_time: "18:15", entrance_time: "18:30" }, moments: [
      { key: "mc", editor: "mc", label: "MC", answers: { mc: "other", name: "Maxime Bélanger-Côté", pronunciation: "max-EEM bay-lahn-ZHAY ko-TAY", contact: "819 555-0133", notes: "Has the full script." } },
      { key: "introductions", editor: "introductions", label: "Introductions", answers: { entries: [
        { id: id(), names: "Parents de la mariée", wording: "Les parents de la mariée, Sylvie et Marc Gagnon", song_id: entranceX.id },
        { id: id(), names: "Parents du marié", pronunciation: "lay-VESK", wording: "Les parents du marié, Hélène et Paul Lévesque", song_id: entranceX.id },
        { id: id(), names: "Le cortège", song_id: entranceY.id },
        { id: id(), names: "Chloé Gagnon et François Lévesque", pronunciation: "klo-AY gah-NYON, frahn-SWAH lay-VESK", wording: "Pour la première fois, M. et Mme Lévesque-Gagnon!", song_id: entranceZ.id },
      ] } },
      { key: "entrance_participants", editor: "included", label: "Participants and names" },
      { key: "entrance_music", editor: "moment_songs", label: "Entrance music", answers: { songs: [entranceX, entranceY, entranceZ, entranceW] } },
    ] },
    { key: "dinner", editor: "stage_dinner", label: "Dinner", answers: { location_source: "event_venue", start_time: "18:45", meal_style: "plated", guest_count_source: "basics" }, moments: [
      { key: "dinner_details", editor: "stage_details", label: "Timing" },
      { key: "dinner_music", editor: "music_background", label: "Background music", answers: { songs: titles(42, "Souper") } },
      { key: "speeches", editor: "speeches", label: "Speeches and toasts", answers: { entries: [
        { id: id(), speaker: "Sylvie Gagnon", role: "Mother of the bride", timing: "time", time: "19:15", duration: 5, av_notes: "Wireless mic, slideshow on screen 2" },
        { id: id(), speaker: "Olivier Lévesque", pronunciation: "oh-lee-VYAY", role: "Best man", timing: "cue", cue: "After the main course" },
        { id: id(), speaker: "Tante Ginette", timing: "undecided" },
      ] } },
      { key: "dinner_activities", editor: "activities", label: "Activities", answers: { entries: [
        { id: id(), name: "Shoe game", timing: "cue", cue: "Between dessert and coffee", host: "Maxime", duration: 10, song_title: "Shoe game theme", song_artist: "The Band" },
      ] } },
      { key: "cake_cutting", editor: "moment_songs", label: "Cake cutting", answers: { songs: [song("Sugar", "Maroon 5")] } },
    ] },
    { key: "special_dances", editor: null, label: "Special dances", moments: [
      { key: "first_dance", editor: "moment_songs", label: "First dance", answers: { songs: [
        song("Perfect", "Ed Sheeran", { cue: "Part 1", notes: "Start at 0:45" }), song("Shut Up and Dance", "WALK THE MOON", { cue: "Part 2", notes: "Surprise switch, fade after 1:30" }),
      ] } },
      { key: "family_dances", editor: "moment_songs", label: "Family dances", answers: { songs: [song("My Girl", "The Temptations", { cue: "Dance with father" })] } },
      { key: "other_dances", editor: "moment_songs", label: "Other special dances", answers: { choice: "not_applicable" } },
    ] },
    { key: "party", editor: "stage_party", label: "Party", answers: { location_source: "event_venue", start_time: "21:00", end_time: "01:00", end_next_day: true, evening_guests: 40 }, moments: [
      { key: "music_preferences", editor: "music_style", label: "Music preferences", answers: { genres: ["pop", "disco_funk"], other_style: "Musique québécoise des années 90", slow_songs: "a_few" } },
      { key: "must_play", editor: "music_requests", label: "Must play", answers: { songs: mustPlay } },
      { key: "play_if_possible", editor: "music_requests", label: "Play if possible", disabled: true, answers: { songs: [song("HIDDEN LIST SONG", "Nobody")] } },
      { key: "do_not_play", editor: "music_exclusions", label: "Do not play", answers: { songs: [banned, song("Macarena", "Los del Río")] } },
      { key: "dedications", editor: "dedications", label: "Dedications", answers: { entries: [
        { id: id(), recipient: "Mamie Lucienne", relationship: "Grandmother", pronunciation: "lu-SYEN", timing: "anytime", message: "Pour ses 90 ans" },
      ] } },
      { key: "party_activities", editor: "activities", label: "Optional activities", answers: { entries: [
        { id: id(), name: "Bouquet toss", timing: "time", time: "00:30", next_day: true, song_title: "Single Ladies", song_artist: "Beyoncé" },
      ] } },
    ] },
    { key: "closing", editor: "stage_closing", label: "Closing", answers: { finish_source: "time", finish_time: "01:00", finish_next_day: true, closing_instructions: "Lights up slowly. Last call at 00:45." }, moments: [
      { key: "last_dances", editor: "moment_songs", label: "Last dances", answers: { songs: [song("Don't Stop Believin'", "Journey")] } },
      { key: "final_song", editor: "moment_songs", label: "Final song", answers: { songs: [song("Ce soir on danse à Naziland", "Les Cowboys Fringants")] } },
      { key: "closing_instructions", editor: "stage_details", label: "Closing instructions" },
    ] },
  ],
  warnings: [{ stageKey: "party", message: "The party starts before dinner ends." }],
  imported: {
    questions: [{ key: "ceremony_location", prompt: "Is the ceremony in a separate space?", answer_type: "single_choice", options: [{ value: "separate_space", label: "Yes, a separate space" }], required: true }],
    answers: { ceremony_location: "separate_space" },
  },
  editing: "closed",
});

const party = planView({
  basics: { guest_count: 60, start_time: "20:00", end_time: "23:30", access_notes_none: true, announcement_language: "english" },
  stages: [
    { key: "party", editor: "stage_party", label: "Party", answers: { location_source: "event_venue", start_time: "20:00", end_time: "23:30" }, moments: [
      { key: "must_play", editor: "music_requests", label: "Must play", answers: { songs: [song("Dancing Queen", "ABBA")] } },
      { key: "do_not_play", editor: "music_exclusions", label: "Do not play", answers: { choice: "none" } },
    ] },
  ],
});

const incomplete = planView({
  basics: { guest_count: 90 },
  general: [{ key: "contacts_vendors", editor: "contacts", label: "Contacts and vendors", answers: { day_of_source: "undecided" } }],
  stages: [
    { key: "ceremony", editor: "stage_ceremony", label: "Ceremony", answers: { location_source: "event_venue" }, moments: [
      { key: "processional", editor: "processional", label: "Processional", answers: { participants_choice: "discuss" } },
    ] },
    { key: "reception_entrance", editor: "stage_entrance", label: "Reception entrance", moments: [
      { key: "mc", editor: "mc", label: "MC", answers: { mc: "discuss" } },
      { key: "introductions", editor: "introductions", label: "Introductions", answers: {} },
    ] },
    { key: "party", editor: "stage_party", label: "Party", moments: [
      { key: "dedications", editor: "dedications", label: "Dedications", answers: { entries: [{ id: id(), recipient: "Paul", timing: "undecided" }] } },
      { key: "speeches", editor: "speeches", label: "Speeches and toasts", answers: { choice: "discuss" } },
    ] },
  ],
  unanswered: [
    { stageKey: "ceremony", key: "start_time" },
    { stageKey: "ceremony", key: "microphones", discuss: true },
    { stageKey: "contacts_vendors", key: "day_of", note: "not_decided" },
  ],
  warnings: [{ stageKey: "party", message: "The party has no start time." }],
});

const all = (sheet: RunSheet) => JSON.stringify(sheet);

describe("run sheet model", () => {
  const sheet = buildRunSheet(input(wedding, { title: "Mariage Gagnon–Lévesque" }));

  it("keeps the configured stage order and leaves hidden stages and moments out", () => {
    expect(sheet.stages.map((s) => s.label)).toEqual(["Cérémonie", "Cocktail", "Reception entrance", "Dinner", "Special dances", "Party", "Closing"]);
    expect(all(sheet)).not.toContain("HIDDEN STAGE TEXT");
    expect(all(sheet)).not.toContain("HIDDEN LIST SONG");
    expect(sheet.musicLists.map((l) => l.label)).not.toContain("Play if possible");
  });

  it("resolves explicit reuse: venue, guest count, overnight times", () => {
    const cocktail = sheet.stages.find((s) => s.key === "cocktail")!;
    expect(cocktail.location).toBe("Event venue: Château Montebello, 392 rue Notre-Dame, Montebello (Québec) · Terrasse");
    expect(sheet.stages.find((s) => s.key === "dinner")!.details).toContainEqual({ label: "Dinner guests", value: "180 (Event basics)" });
    const finish = sheet.stages.find((s) => s.key === "closing")!.times[0];
    expect(whenText(finish.when, "2027-08-14")).toBe("01:00 (next day, Sun, Aug 15)");
    expect(sheet.times[0]).toEqual({ label: "DJ service (Event basics)", value: "15:00 – 01:00 (next day, Sun, Aug 15)" });
    expect(sheet.essentials).toContainEqual(expect.objectContaining({ label: "Day-of contact", value: "Chloé Gagnon · +1 819 555-0142 (phone for the day)", phone: "+1 819 555-0142" }));
    expect(sheet.essentials).toContainEqual(expect.objectContaining({ label: "MC", value: "Maxime Bélanger-Côté [max-EEM bay-lahn-ZHAY ko-TAY] 819 555-0133" }));
    expect(sheet.essentials).toContainEqual({ label: "Officiant", value: "Père Jean-François Létourneau · 819 555-0177" });
  });

  it("links people to their songs once, with names and pronunciation together", () => {
    const ceremony = sheet.stages.find((s) => s.key === "ceremony")!;
    const proc = ceremony.rows.filter((r) => r.title.startsWith("Processional"));
    expect(proc.map((r) => [r.people.map((p) => p.names), r.songs.map((s) => s.title)])).toEqual([
      [["Grand-maman Thérèse et grand-papa Réjean"], ["Canon in D"]],
      [["Anne-Sophie Desjardins-Ouellette", "Gabrielle Nguyễn"], ["A Thousand Years"]],
    ]);
    const couple = ceremony.rows.find((r) => r.title === "Couple entrance")!;
    expect(couple.people.map((p) => p.names)).toEqual(["Chloé & François"]);
    expect(couple.songs[0]).toMatchObject({ title: "La vie en rose", notes: "Start at 0:20, fade at the second chorus" });

    const entrance = sheet.stages.find((s) => s.key === "reception_entrance")!;
    const intro = entrance.rows.filter((r) => r.title.startsWith("Introductions"));
    expect(intro.map((r) => [r.people.map((p) => p.names), r.songs.map((s) => s.title)])).toEqual([
      [["Parents de la mariée", "Parents du marié"], ["September"]],
      [["Le cortège"], ["Uptown Funk"]],
      [["Chloé Gagnon et François Lévesque"], ["Crazy in Love"]],
    ]);
    expect(intro[2].people[0]).toMatchObject({ pronunciation: "klo-AY gah-NYON, frahn-SWAH lay-VESK", wording: "Pour la première fois, M. et Mme Lévesque-Gagnon!" });
    // Entrance music shows only the song nobody is linked to: the others are already with their people.
    const music = entrance.rows.filter((r) => r.title.startsWith("Entrance music"));
    expect(music.flatMap((r) => r.songs.map((s) => s.title))).toEqual(["Unused intro"]);
    const allEntranceSongs = entrance.rows.flatMap((r) => r.songs.map((s) => s.title));
    expect(allEntranceSongs.filter((t) => t === "September")).toHaveLength(1);
  });

  it("keeps cues, undecided times and explicit choices distinct", () => {
    const dinner = sheet.stages.find((s) => s.key === "dinner")!;
    const speeches = dinner.rows.filter((r) => r.title === "Speech");
    expect(speeches.map((r) => whenText(r.when, "2027-08-14"))).toEqual(["19:15", "Cue: After the main course", "Time not decided yet"]);
    expect(speeches[0].notes).toEqual(["About 5 min", "AV: Wireless mic, slideshow on screen 2"]);
    const dances = sheet.stages.find((s) => s.key === "special_dances")!;
    expect(dances.rows.find((r) => r.title === "Other special dances")!.status?.text).toBe("Not applicable: this moment won't happen");
    expect(sheet.stages.find((s) => s.key === "ceremony")!.rows.find((r) => r.title === "Signing")!.status?.text).toBe("DJ's choice");
    expect(sheet.musicLists.find((l) => l.key === "cocktail_music")!.status?.text).toBe("DJ's choice: no suggestions");
    const party = sheet.stages.find((s) => s.key === "party")!;
    expect(whenText(party.rows.find((r) => r.title === "Bouquet toss")!.when, "2027-08-14")).toBe("00:30 (next day, Sun, Aug 15)");
    expect(party.rows.find((r) => r.title.startsWith("Dedication"))!.warning).toBe("Still needs: song");
    expect(whenText(party.rows.find((r) => r.title.startsWith("Dedication"))!.when, "2027-08-14")).toBe("Any time during the party");
  });

  it("warns about timing, song contradictions and stage times outside the DJ service", () => {
    const texts = sheet.warnings.map((w) => w.text);
    expect(texts).toContain("Party: The party starts before dinner ends.");
    expect(texts).toContain('"chicken  dance" by werner thomas is on Do not play and also in Party · Must play.');
  });

  it("keeps preferences, vendors and the frozen proposal answers, and never staff-only data", () => {
    expect(sheet.preferences).toEqual(expect.arrayContaining([
      { label: "Announcement language", value: "Bilingual (French and English)" },
      { label: "Explicit lyrics", value: "Clean versions only" },
      { label: "Guest requests", value: "Guests may request songs (never anything on Do not play)" },
    ]));
    expect(sheet.vendors.entries[0]).toMatchObject({ role: "Photographer", name: "Marie-Ève Tremblay-Bouchard, Studio Lumière d'Outaouais" });
    expect(sheet.imported?.answers).toEqual([{ label: "Is the ceremony in a separate space?", value: "Yes, a separate space" }]);
    expect(all(sheet)).not.toContain("SECRET AUDIT REASON");
    expect(all(sheet)).not.toContain("staff-secret@");
    expect(sheet.editing).toMatch(/^Client editing closed since .*Staff can still change the plan\.$/);
  });

  it("says when staff closed client editing; the content (and so the revision) doesn't depend on it", () => {
    const v = wedding.plan === null ? wedding : { ...wedding, editing: { ...wedding.editing!, closed_by_dj: true, closed_at: "2027-07-01T15:00:00+00:00" } };
    const closed = buildRunSheet(input(v, { title: "Mariage Gagnon–Lévesque" }));
    expect(closed.editing).toMatch(/^Client editing closed by staff since Thursday, July 1, 2027 .*Staff can still change the plan\.$/);
    const { editing: _a, asOf: _b, ...withClose } = closed;
    const { editing: _c, asOf: _d, ...without } = sheet;
    void [_a, _b, _c, _d];
    expect(withClose).toEqual(without);
  });

  it("a Simple Party plan and an unset plan", () => {
    const p = buildRunSheet(input(party, { title: "Fête de Sam" }));
    expect(p.stages.map((s) => s.label)).toEqual(["Party"]);
    expect(p.musicLists.find((l) => l.kind === "exclusions")!.status?.text).toBe("Nothing to exclude");
    expect(p.essentials).toContainEqual({ label: "Access and load-in", value: "No special instructions" });
    const none = buildRunSheet(input({ plan: null } as never));
    expect(none.planReady).toBe(false);
    expect(none.stages).toEqual([]);
  });

  it("an incomplete plan lists what's open instead of hiding it", () => {
    const i = buildRunSheet(input(incomplete));
    const texts = i.warnings.map((w) => w.text);
    expect(texts).toEqual(expect.arrayContaining([
      "Ceremony: Start time",
      "Ceremony: Microphone needs (discuss with DJ)",
      "Contacts and vendors: Day-of contact with a phone (not decided yet)",
      "Party: The party has no start time.",
    ]));
    expect(i.essentials).toContainEqual(expect.objectContaining({ label: "Day-of contact", value: "Not decided yet", warn: true }));
    expect(i.essentials).toContainEqual(expect.objectContaining({ label: "Access and load-in", value: "Not answered yet", warn: true }));
    const ceremony = i.stages[0];
    expect(whenText(ceremony.times[0].when, "2027-08-14")).toBe("Not set");
    expect(ceremony.rows.map((r) => [r.title, r.status?.text])).toEqual([["Processional: songs", "Not answered yet"], ["Processional: who walks in", "Discuss with DJ (still open)"]]);
    expect(i.stages[1].rows.map((r) => r.status?.text)).toEqual(["Discuss with DJ (still open)", "Not answered yet"]);
    expect(i.stages[2].rows[0]).toMatchObject({ warning: "Still needs: timing and song" });
  });

  it("names the download safely", () => {
    expect(runSheetFileName("Mariage Gagnon–Lévesque", "2027-08-14")).toBe("run-sheet-mariage-gagnon-levesque-2027-08-14.pdf");
    expect(runSheetFileName("", "x")).toBe("run-sheet-event-undated.pdf");
  });
});

describe("run sheet PDF", () => {
  mkdirSync("review-samples/run-sheet", { recursive: true });
  it("renders the detailed wedding: sections, accents, pronunciation beside names, nothing internal", async () => {
    const sheet = buildRunSheet(input(wedding, { title: "Mariage Gagnon–Lévesque" }, "ÉCLAIR DJ"));
    const bytes = await renderRunSheetPdf(sheet, "AB12CD34");
    const pages = await pdfPageTexts(bytes);
    await rasterizePdf(bytes, "review-samples/run-sheet/wedding");
    writeFileSync("review-samples/run-sheet/wedding.pdf", bytes);
    const text = pages.join("\n");
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pages[0]).toContain("Mariage Gagnon–Lévesque");
    expect(pages[0]).toContain("Revision AB12CD34");
    expect(pages[0]).toContain("Gig overview");
    for (const heading of ["Planning details", "Music lists", "DO NOT PLAY", "From the signed proposal (frozen answers)"]) expect(text).toContain(heading);
    expect(text).toContain("Chloé Gagnon et François Lévesque [klo-AY gah-NYON, frahn-SWAH lay-VESK]");
    expect(text).toContain("Cue: After the main course");
    expect(text).toContain("01:00 (next day, Sun, Aug 15)");
    expect(text).toMatch(/Page 1 of \d+/);
    // The column header repeats on every page of the gig overview, and only there.
    const details = pages.findIndex((p) => p.includes("Planning details"));
    expect(details).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(p.includes("TIME / CUE")).toBe(i < details));
    for (const bad of ["undefined", "null", "[object", "SECRET AUDIT", "staff-secret", "HIDDEN", "countersign", "contract"]) expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(text).not.toMatch(UUID);
    // Every must-play song is listed, in order.
    expect(text.indexOf("Party chanson 1 ")).toBeLessThan(text.indexOf("Party chanson 58"));
  });

  it("renders a short party plan compactly", async () => {
    const bytes = await renderRunSheetPdf(buildRunSheet(input(party, { title: "Fête de Sam", event_type: "private_party", venue_name: null, venue_address: null }, "BOUPROD")), "0000AAAA");
    const pages = await pdfPageTexts(bytes);
    await rasterizePdf(bytes, "review-samples/run-sheet/party");
    writeFileSync("review-samples/run-sheet/party.pdf", bytes);
    expect(pages.length).toBeLessThanOrEqual(3);
    expect(pages[0]).toContain("Venue not entered yet");
    expect(pages.join(" ")).toContain("Nothing to exclude");
  });

  it("renders an incomplete plan with its warnings, and an archived event", async () => {
    const bytes = await renderRunSheetPdf(buildRunSheet(input(incomplete, { archived_at: "2026-10-01T00:00:00Z" })), "FFFF0000");
    const pages = await pdfPageTexts(bytes);
    await rasterizePdf(bytes, "review-samples/run-sheet/incomplete");
    writeFileSync("review-samples/run-sheet/incomplete.pdf", bytes);
    expect(pages[0]).toContain("ARCHIVED EVENT");
    expect(pages[0]).toContain("TO CHECK");
    expect(pages[0]).toContain("Not answered yet: Ceremony: Start time · Ceremony: Microphone needs (discuss with DJ)");
    expect(pages.join(" ")).toContain("Still needs: timing and song");
  });
});
