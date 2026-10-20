import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptySong, musicAnswersFromForm } from "@/lib/planning/music";
import { mcAnswersFromForm, mcForm } from "@/lib/planning/participants";
import { DISCUSS, answerSummary, clock, names, type SummaryContext } from "@/lib/planning/summaries";

const ctx: SummaryContext = {
  djName: "BOUPROD",
  djDisplayName: "DJ Boukine",
  venueName: "Château Ramezay Gardens",
  eventContacts: [{ id: "c1", name: "Sarah Lee", phone: "514 555-0100", primary: true }],
};
const song = (title: string, artist: string) => ({ id: randomUUID(), title, artist });
const sum = (editor: string, answers: Record<string, unknown>) => answerSummary(editor, answers, ctx);

describe("answer summaries: music", () => {
  it("shows a moment's song itself, and how many more", () => {
    expect(sum("moment_songs", { songs: [song("Better Together", "Jack Johnson")] })).toBe("Better Together · Jack Johnson");
    expect(sum("moment_songs", { songs: [song("Better Together", "Jack Johnson"), song("Banana Pancakes", "Jack Johnson")] })).toBe(
      "Better Together · Jack Johnson +1 more",
    );
  });

  it("counts songs and playlists in a list", () => {
    const songs = [song("A", "X"), song("B", "Y"), song("C", "Z"), song("D", "W")];
    const playlists = [{ id: randomUUID(), url: "https://open.spotify.com/playlist/1" }, { id: randomUUID(), url: "https://music.apple.com/pl/2" }];
    expect(sum("music_requests", { songs, playlists })).toBe("4 songs · 2 playlists");
    expect(sum("music_requests", { playlists: playlists.slice(0, 1) })).toBe("1 playlist");
    // One song in a list still reads as the song.
    expect(sum("music_exclusions", { songs: [song("Macarena", "Los del Río")] })).toBe("Macarena · Los del Río");
  });

  it("names each choice in plain words", () => {
    expect(sum("music_requests", { choice: "none" })).toBe("No requests");
    expect(sum("music_exclusions", { choice: "none" })).toBe("Nothing to avoid");
    expect(sum("music_background", { choice: "dj_choice" })).toBe("DJ's choice");
    expect(sum("moment_songs", { choice: "not_applicable" })).toBe("Not happening");
    expect(sum("moment_songs", { choice: "discuss" })).toBe(DISCUSS);
  });

  it("has no preview for an empty answer, and never shows raw values", () => {
    expect(sum("moment_songs", {})).toBeNull();
    expect(sum("music_requests", { songs: [] })).toBeNull();
    expect(answerSummary("moment_songs", null, ctx)).toBeNull();
    expect(answerSummary(null, { songs: [song("A", "B")] }, ctx)).toBeNull();
    expect(sum("unknown_editor", { choice: "dj_choice" })).toBeNull();
    const text = sum("music_requests", { songs: [song("A", "B"), song("C", "D")] }) ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|[{}[\]]|_/);
  });

  it("follows the editor's live, unsaved form exactly as its own parser reads it", () => {
    // What the client has typed (not saved yet): the editor parses it into the answers it would save.
    const form = { songs: [{ ...emptySong(randomUUID()), title: "  September ", artist: "Earth, Wind & Fire" }], choice: "" as const };
    const parsed = musicAnswersFromForm("moment_songs", form);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(sum("moment_songs", parsed.answers)).toBe("September · Earth, Wind & Fire");
  });
});

describe("answer summaries: people", () => {
  it("counts who walks in and their songs; partial answers show only what is there", () => {
    const participants = [{ id: "1", names: "Alex" }, { id: "2", names: "The bridesmaids" }, { id: "3", names: "Sam and Jo" }];
    expect(sum("processional", { participants, songs: [song("A", "B"), song("C", "D")] })).toBe("3 entries walking in · 2 songs");
    expect(sum("processional", { participants: participants.slice(0, 1) })).toBe("1 entry walking in");
    expect(sum("processional", { participants_choice: "discuss", choice: "dj_choice" })).toBe("Who walks in: to discuss · DJ's choice of music");
    expect(sum("processional", { choice: "not_applicable" })).toBe("Not happening");
  });

  it("summarises introductions and speeches, in order", () => {
    expect(sum("introductions", { entries: [{ id: "1", names: "A" }, { id: "2", names: "B" }], songs: [song("X", "Y")] })).toBe("2 introductions · 1 song");
    expect(sum("introductions", { choice: "none" })).toBe("No introductions");
    expect(sum("introductions", { choice: "discuss" })).toBe(DISCUSS);
    const entries = ["Maria", "Tom", "Priya", "Jean"].map((speaker, i) => ({ id: String(i), speaker, timing: "undecided" }));
    expect(sum("speeches", { entries })).toBe("4 speeches · Maria, Tom +2 more");
    expect(sum("speeches", { entries: entries.slice(0, 1) })).toBe("1 speech · Maria");
    expect(sum("speeches", { choice: "none" })).toBe("No speeches");
  });

  it("names the MC, including shared duties and older answers", () => {
    expect(sum("mc", { mc: "dj" })).toBe("DJ Boukine (your DJ)");
    expect(answerSummary("mc", { mc: "dj" }, { djName: "BOUPROD" })).toBe("BOUPROD (your DJ)");
    expect(sum("mc", { mc: "shared", name: "Sarah" })).toBe("DJ Boukine + Sarah");
    expect(sum("mc", { mc: "shared" })).toBe("DJ Boukine + another MC");
    expect(sum("mc", { mc: "other", name: "Uncle Rob" })).toBe("Uncle Rob");
    expect(sum("mc", { mc: "discuss" })).toBe(DISCUSS);
    // Staff read the same answers in their own terms.
    expect(answerSummary("mc", { mc: "dj" }, { ...ctx, audience: "staff" })).toBe("DJ Boukine (DJ)");
    expect(answerSummary("moment_songs", { choice: "discuss" }, { ...ctx, audience: "staff" })).toBe("To discuss with the client");
    // "No MC" is no longer offered; saved answers keep it.
    expect(sum("mc", { mc: "none" })).toBe("No MC");
    // Live: the MC form as typed.
    const parsed = mcAnswersFromForm({ ...mcForm({}), mc: "shared", name: "Sarah" });
    expect(parsed.ok && sum("mc", parsed.answers)).toBe("DJ Boukine + Sarah");
  });
});

describe("answer summaries: timed lists, stages and general sections", () => {
  it("lists activities and dedications by name, with how many", () => {
    expect(sum("activities", { entries: [{ id: "1", name: "Cake cutting" }, { id: "2", name: "Speeches" }] })).toBe("2 activities · Cake cutting, Speeches");
    expect(sum("activities", { entries: [{ id: "1", name: "Shoe game" }] })).toBe("Shoe game");
    expect(sum("activities", { choice: "none" })).toBe("No activities");
    expect(sum("dedications", { entries: ["Grandma Rose", "Uncle Tom", "Mia"].map((recipient, i) => ({ id: String(i), recipient })) })).toBe(
      "3 dedications · Grandma Rose, Uncle Tom +1 more",
    );
    expect(sum("program", { start_time: "19:30", entries: [{ id: "1", title: "Welcome" }] })).toBe("7:30 p.m. · Welcome");
  });

  it("reads stage details: place and time, with the venue's own name", () => {
    expect(sum("stage_ceremony", { location_source: "event_venue", start_time: "16:00", end_time: "16:45" })).toBe("Château Ramezay Gardens · 4:00 p.m.–4:45 p.m.");
    expect(sum("stage_ceremony", { location_source: "other", location_other: "Outdoor garden", start_time: "16:00", microphones: "discuss" })).toBe(
      "Outdoor garden · 4:00 p.m. · Microphones: to discuss",
    );
    expect(sum("stage_party", { start_time: "21:00", end_time: "01:00", end_next_day: true })).toBe("9:00 p.m.–1:00 a.m. (next day)");
    expect(sum("stage_entrance", { grand_entrance: "planned", entrance_time: "18:15" })).toBe("Grand entrance at 6:15 p.m.");
    expect(sum("stage_entrance", { entrance_none: true })).toBe("No grand entrance");
    expect(sum("stage_dinner", { meal_style: "buffet", guest_count_source: "number", guest_count: 120 })).toBe("Buffet · 120 guests");
    expect(sum("stage_closing", { finish_source: "basics_end" })).toBe("Ends with the event");
  });

  it("summarises contacts, DJ expectations, music style and Event basics", () => {
    expect(sum("contacts", { day_of_source: "event_contact", day_of_client_id: "c1", vendors: [{ id: "1", role: "planner" }, { id: "2", role: "photographer" }] })).toBe(
      "Day-of: Sarah Lee · 2 vendors: Planner or coordinator, Photographer",
    );
    expect(sum("contacts", { vendors_choice: "none" })).toBe("No vendors");
    expect(sum("preferences", { interaction: "a_little", lyrics: "clean", requests: "discuss" })).toBe("A little interaction · Clean versions only · 1 to discuss");
    expect(sum("preferences", { interaction: "music_mostly" })).toBe("Minimal interaction");
    // Older answers keep their label.
    expect(sum("preferences", { interaction: "occasional" })).toBe("Occasional announcements");
    expect(sum("music_style", { genres: ["pop", "rock", "latin", "country"], slow_songs: "a_few" })).toBe("Pop, Rock, Latin +1 more · Slow songs: a few");
    expect(sum("music_style", { style_choice: "dj_choice" })).toBe("DJ's choice");
    expect(sum("basics", { start_time: "15:30", end_time: "23:00", guest_count: 150, announcement_language: "bilingual" })).toBe(
      "3:30 p.m.–11:00 p.m. · 150 guests · Announcements: Bilingual (French and English)",
    );
  });

  it("keeps long text whole for the layout to truncate, and lists stay short", () => {
    const long = "Don't Stop Me Now (2011 Remaster) - Extended Celebration Mix for the whole family";
    expect(sum("moment_songs", { songs: [song(long, "Queen")] })).toBe(`${long} · Queen`);
    expect(names(["a", "b", "c", "d", "e"])).toBe("a, b +3 more");
    expect(names(["", "  "])).toBeNull();
  });

  it("formats clock times and ignores anything else", () => {
    expect(clock("00:05")).toBe("12:05 a.m.");
    expect(clock("12:00")).toBe("12:00 p.m.");
    expect(clock("23:59", true)).toBe("11:59 p.m. (next day)");
    expect(clock("25:00")).toBeNull();
    expect(clock(undefined)).toBeNull();
  });
});
