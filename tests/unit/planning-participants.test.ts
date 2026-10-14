import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import { emptySong } from "@/lib/planning/music";
import {
  emptyPerson,
  emptySpeech,
  introductionsAnswersFromForm,
  linksBySong,
  mcAnswersFromForm,
  newSongProblem,
  processionalAnswersFromForm,
  processionalForm,
  songLabel,
  speechResolved,
  speechesAnswersFromForm,
  speechesForm,
  withNewSongs,
  type ProcessionalForm,
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

describe("Processional songs entered right with a person", () => {
  const S3 = "55555555-5555-4555-8555-555555555555";
  const P3 = "66666666-6666-4666-8666-666666666666";
  const base: ProcessionalForm = { songs: [song(S1, "Canon in D")], choice: "", participants: [person(P1, "Groom and his mother", { song_id: S1 })], participants_choice: "" };
  const draft = (extra = {}) => ({ id: S3, title: " A Thousand Years ", artist: " Christina Perri ", notes: " Start at 0:20 ", ...extra });

  it("adding a person with a new song adds the song and links it in one change", () => {
    const added = withNewSongs(base, [...base.participants, { ...person(P2, "Bridesmaids"), new_song: draft() }]);
    expect(added.songs.map((x) => [x.id, x.title, x.artist, x.notes])).toEqual([[S1, "Canon in D", "Artist", ""], [S3, "A Thousand Years", "Christina Perri", "Start at 0:20"]]);
    expect(added.participants[1]).toMatchObject({ song_id: S3, new_song: null });
    const r = processionalAnswersFromForm({ ...base, ...added });
    expect(r.ok && r.answers.participants!.map((p) => p.song_id)).toEqual([S1, S3]);
    expect(r.ok && r.answers.songs!.length).toBe(2);
    // A doubled add finds the song already listed: never two copies.
    const again = withNewSongs({ ...base, songs: added.songs }, [...base.participants, { ...person(P2, "Bridesmaids"), new_song: draft() }]);
    expect(again.songs).toHaveLength(2);
  });

  it("several people share one song by linking it; removing one leaves the song and the others alone", () => {
    const shared: ProcessionalForm = { ...base, participants: [...base.participants, person(P2, "Flower girl", { song_id: S1 }), person(P3, "Bride and her father")] };
    const r = processionalAnswersFromForm(shared);
    expect(r.ok && r.answers.participants!.map((p) => p.song_id ?? null)).toEqual([S1, S1, null]);
    const removed = processionalAnswersFromForm({ ...shared, participants: shared.participants.filter((p) => p.id !== P2) });
    expect(removed.ok && [removed.answers.songs!.map((x) => x.id), removed.answers.participants!.map((p) => p.id)]).toEqual([[S1], [P1, P3]]);
  });

  it("a listed person's new song waits until \"Use this song\", then joins and links", () => {
    const typing = withNewSongs(base, [{ ...base.participants[0], new_song: draft() }]);
    expect([typing.songs.length, typing.participants[0].song_id]).toEqual([1, S1]);
    expect(processionalAnswersFromForm({ ...base, ...typing })).toEqual(processionalAnswersFromForm(base));
    const used = withNewSongs(base, [{ ...base.participants[0], new_song: draft({ use: true }) }]);
    expect([used.songs.length, used.participants[0].song_id, used.participants[0].new_song]).toEqual([2, S3, null]);
  });

  it("an unfinished new song is pointed at, never saved half-linked; a blank one is dropped", () => {
    expect(newSongProblem(draft({ artist: "" }), 5)).toMatchObject({ field: "song_artist" });
    expect(newSongProblem(draft({ title: "" }), 5)).toMatchObject({ field: "song_title" });
    expect(newSongProblem(draft(), 0)).toMatchObject({ field: "song_title", message: expect.stringContaining("maximum of 12 songs") });
    expect(newSongProblem({ id: S3, title: " ", artist: "", notes: "" }, 5)).toBeNull();
    const half = withNewSongs(base, [{ ...base.participants[0], new_song: draft({ artist: "", use: true }) }]);
    expect([half.songs.length, half.participants[0].song_id]).toEqual([1, S1]);
    const blank = withNewSongs(base, [...base.participants, { ...person(P2, "Ring bearer"), new_song: { id: S3, title: "", artist: "", notes: "" } }]);
    expect([blank.songs.length, blank.participants[1].song_id, blank.participants[1].new_song]).toEqual([1, "", null]);
  });

  it("keeps an older pronunciation guide it no longer asks for", () => {
    const saved = { songs: [{ id: S1, title: "Canon", artist: "Pachelbel" }], participants: [{ id: P1, names: "Thérèse", pronunciation: "tay-REZ", song_id: S1 }] };
    const r = processionalAnswersFromForm(processionalForm(saved));
    expect(r.ok && answersKey(r.answers)).toBe(answersKey(saved));
  });
});
