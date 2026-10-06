import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import { emptySong } from "@/lib/planning/music";
import {
  emptyPerson,
  emptySpeech,
  introductionsAnswersFromForm,
  linksBySong,
  mcAnswersFromForm,
  processionalAnswersFromForm,
  processionalForm,
  songLabel,
  speechResolved,
  speechesAnswersFromForm,
  speechesForm,
} from "@/lib/planning/participants";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const P2 = "44444444-4444-4444-8444-444444444444";
const song = (id: string, title: string) => ({ ...emptySong(id), title, artist: "Artist" });
const person = (id: string, names: string, extra = {}) => ({ ...emptyPerson(id), names, ...extra });

describe("Processional (mirror of private.normalize_plan_processional)", () => {
  it("keeps its songs and adds who walks in, trimmed, with links to its own songs", () => {
    const r = processionalAnswersFromForm({
      songs: [song(S1, "Canon in D")], choice: "",
      participants: [person(P1, "  Sam & Jo ", { song_id: S1, role: " " }), person(P2, "Alex with their mother Dana", { pronunciation: "ah-LEX" })],
      participants_choice: "",
    });
    expect(r).toEqual({ ok: true, answers: {
      songs: [{ id: S1, title: "Canon in D", artist: "Artist" }],
      participants: [{ id: P1, names: "Sam & Jo", song_id: S1 }, { id: P2, names: "Alex with their mother Dana", pronunciation: "ah-LEX" }],
    } });
  });

  it("passes a link to another moment's song (Couple entrance) to the server, refuses malformed ids and not applicable while people are listed", () => {
    const base = { songs: [song(S1, "Canon")], choice: "" as const, participants_choice: "" as const };
    // Which songs a link may name is checked by the database, which sees Couple entrance too.
    expect(processionalAnswersFromForm({ ...base, participants: [person(P1, "Alex & Sam", { song_id: S2 })] })).toMatchObject({ ok: true });
    expect(processionalAnswersFromForm({ ...base, participants: [person(P1, "Sam", { song_id: "canon" })] })).toMatchObject({ ok: false, field: `entry:${P1}:song_id` });
    expect(processionalAnswersFromForm({ ...base, choice: "not_applicable", songs: [], participants: [person(P1, "Sam")] })).toMatchObject({ ok: false, field: "choice" });
    expect(processionalAnswersFromForm({ ...base, participants: [person(P1, "  ")] })).toMatchObject({ ok: false, field: `entry:${P1}:names` });
  });

  it("round-trips saved answers unchanged", () => {
    const saved = { songs: [{ id: S1, title: "Canon", artist: "Pachelbel", cue: "Party" }], participants: [{ id: P1, names: "Sam", song_id: S1 }], participants_choice: "discuss" as const };
    const again = processionalAnswersFromForm(processionalForm(saved));
    expect(again.ok && answersKey(again.answers)).toBe(answersKey(saved));
  });
});

describe("Introductions", () => {
  it("lets several entries share a song id; the server checks it against Entrance music", () => {
    const r = introductionsAnswersFromForm({ entries: [person(P1, "Sam and Jo", { song_id: S1 }), person(P2, "The wedding party", { song_id: S1, wording: "Please welcome" })], choice: "" });
    expect(r.ok && r.answers.entries!.map((e) => e.song_id)).toEqual([S1, S1]);
    expect(r.ok && r.answers.entries![1].wording).toBe("Please welcome");
  });
  it('refuses "No introductions" while entries exist', () => {
    expect(introductionsAnswersFromForm({ entries: [person(P1, "Sam")], choice: "none" })).toMatchObject({ ok: false, field: "choice" });
    expect(introductionsAnswersFromForm({ entries: [], choice: "none" })).toEqual({ ok: true, answers: { choice: "none" } });
  });
});

describe("Speeches", () => {
  const speech = (extra: Partial<ReturnType<typeof emptySpeech>>) => ({ ...emptySpeech(P1), speaker: "Dana", ...extra });

  it("keeps only the chosen timing's fields; next day needs a time", () => {
    expect(speechesAnswersFromForm({ entries: [speech({ timing: "cue", cue: " After the main course ", time: "20:00", next_day: true })], choice: "" }))
      .toEqual({ ok: true, answers: { entries: [{ id: P1, speaker: "Dana", timing: "cue", cue: "After the main course" }] } });
    expect(speechesAnswersFromForm({ entries: [speech({ timing: "time", time: "00:30", next_day: true, duration: "5" })], choice: "" }))
      .toEqual({ ok: true, answers: { entries: [{ id: P1, speaker: "Dana", timing: "time", time: "00:30", next_day: true, duration: 5 }] } });
    expect(speechesAnswersFromForm({ entries: [speech({ timing: "time", time: "", next_day: true })], choice: "" }))
      .toEqual({ ok: true, answers: { entries: [{ id: P1, speaker: "Dana", timing: "time" }] } });
  });

  it("validates times, durations and the speaker", () => {
    expect(speechesAnswersFromForm({ entries: [speech({ timing: "time", time: "8pm" })], choice: "" })).toMatchObject({ ok: false, field: `entry:${P1}:time` });
    expect(speechesAnswersFromForm({ entries: [speech({ timing: "cue", cue: "x", duration: "0" })], choice: "" })).toMatchObject({ ok: false, field: `entry:${P1}:duration` });
    expect(speechesAnswersFromForm({ entries: [speech({ speaker: " " })], choice: "" })).toMatchObject({ ok: false, field: `entry:${P1}:speaker` });
  });

  it("counts a speech once it has a time or a cue; undecided stays open", () => {
    expect(speechResolved({ id: P1, speaker: "Dana", timing: "cue", cue: "Dessert" })).toBe(true);
    expect(speechResolved({ id: P1, speaker: "Dana", timing: "time", time: "20:00" })).toBe(true);
    expect(speechResolved({ id: P1, speaker: "Dana", timing: "cue" })).toBe(false);
    expect(speechResolved({ id: P1, speaker: "Dana", timing: "undecided" })).toBe(false);
  });

  it("round-trips saved answers unchanged", () => {
    const saved = { entries: [{ id: P1, speaker: "Dana", timing: "time" as const, time: "00:30", next_day: true as const, duration: 4, av_notes: "Handheld" }], choice: "discuss" as const };
    const again = speechesAnswersFromForm(speechesForm(saved));
    expect(again.ok && answersKey(again.answers)).toBe(answersKey(saved));
  });
});

describe("MC", () => {
  it("keeps someone else's details only when someone else is the MC", () => {
    const form = { mc: "dj" as const, name: "Kiara", pronunciation: "kee-AR-ah", contact: "k@example.test", notes: "Bilingual" };
    expect(mcAnswersFromForm(form)).toEqual({ ok: true, answers: { mc: "dj", notes: "Bilingual" } });
    expect(mcAnswersFromForm({ ...form, mc: "other" })).toEqual({ ok: true, answers: { mc: "other", name: "Kiara", pronunciation: "kee-AR-ah", contact: "k@example.test", notes: "Bilingual" } });
  });
});

describe("song links", () => {
  it("lists who uses each song, and reads titles through the link", () => {
    expect(linksBySong([{ names: "Sam", song_id: S1 }, { names: "Jo", song_id: S1 }, { names: "Alex" }])).toEqual(new Map([[S1, ["Sam", "Jo"]]]));
    expect(songLabel({ title: "Uptown Funk", artist: "Mark Ronson", cue: "Wedding party" })).toBe("Wedding party: Uptown Funk by Mark Ronson");
    expect(songLabel(undefined)).toBeNull();
  });
});
