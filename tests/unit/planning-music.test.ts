import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import {
  conflictsFor,
  duplicateIds,
  emptySong,
  musicAnswersFromForm,
  musicFormFromAnswers,
  parsePastedList,
  pastedRowProblem,
  type SavedList,
} from "@/lib/planning/music";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const song = (id: string, title: string, artist: string, extra = {}) => ({ ...emptySong(id), title, artist, ...extra });
let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe("music answers (mirror of private.normalize_plan_music)", () => {
  it("trims, drops empty optional fields and keeps list order and ids", () => {
    const r = musicAnswersFromForm("music_requests", { songs: [song(B, "  Two ", " Y "), song(A, "One", "X", { version: " ", link: "https://example.com/a" })], choice: "" });
    expect(r).toEqual({ ok: true, answers: { songs: [{ id: B, title: "Two", artist: "Y" }, { id: A, title: "One", artist: "X", link: "https://example.com/a" }] } });
  });

  it("needs title and artist, and points at the song's field", () => {
    expect(musicAnswersFromForm("music_requests", { songs: [song(A, "One", "")], choice: "" })).toMatchObject({ ok: false, field: `song:${A}:artist` });
    expect(musicAnswersFromForm("music_requests", { songs: [song(A, "", "X")], choice: "" })).toMatchObject({ ok: false, field: `song:${A}:title` });
  });

  it("accepts only safe https links, never credentials or other schemes", () => {
    for (const link of ["http://example.com", "https://user:pw@example.com", "javascript:alert(1)", "https://example", "https://exa mple.com"]) {
      expect(musicAnswersFromForm("music_requests", { songs: [song(A, "One", "X", { link })], choice: "" })).toMatchObject({ ok: false, field: `song:${A}:link` });
    }
  });

  it("keeps a cue only for moment songs", () => {
    expect(musicAnswersFromForm("moment_songs", { songs: [song(A, "One", "X", { cue: "Couple", notes: "Start at 0:45" })], choice: "" }))
      .toEqual({ ok: true, answers: { songs: [{ id: A, title: "One", artist: "X", cue: "Couple", notes: "Start at 0:45" }] } });
    expect(musicAnswersFromForm("music_requests", { songs: [song(A, "One", "X", { cue: "Couple" })], choice: "" }))
      .toEqual({ ok: true, answers: { songs: [{ id: A, title: "One", artist: "X" }] } });
  });

  it("refuses an exclusive choice while songs exist, but allows discuss with songs", () => {
    expect(musicAnswersFromForm("music_requests", { songs: [song(A, "One", "X")], choice: "none" })).toMatchObject({ ok: false, field: "choice" });
    expect(musicAnswersFromForm("moment_songs", { songs: [song(A, "One", "X")], choice: "not_applicable" })).toMatchObject({ ok: false, field: "choice" });
    expect(musicAnswersFromForm("moment_songs", { songs: [song(A, "One", "X")], choice: "discuss" })).toMatchObject({ ok: true });
    expect(musicAnswersFromForm("music_exclusions", { songs: [], choice: "none" })).toEqual({ ok: true, answers: { choice: "none" } });
    expect(musicAnswersFromForm("music_background", { songs: [], choice: "none" })).toMatchObject({ ok: false, field: "choice" });
  });

  it("refuses duplicate or malformed ids and too many songs", () => {
    expect(musicAnswersFromForm("music_requests", { songs: [song(A, "One", "X"), song(A, "Two", "Y")], choice: "" })).toMatchObject({ ok: false, field: "songs" });
    expect(musicAnswersFromForm("music_requests", { songs: [song("1", "One", "X")], choice: "" })).toMatchObject({ ok: false, field: "songs" });
    const many = Array.from({ length: 13 }, (_, i) => song(ids(), `S${i}`, "X"));
    expect(musicAnswersFromForm("moment_songs", { songs: many, choice: "" })).toMatchObject({ ok: false, field: "songs" });
  });

  it("round-trips saved answers through the form unchanged", () => {
    const saved = { songs: [{ id: A, title: "One", artist: "X", version: "Live" }], choice: "discuss" as const };
    const again = musicAnswersFromForm("moment_songs", musicFormFromAnswers(saved));
    expect(again.ok && answersKey(again.answers)).toBe(answersKey(saved));
  });

  it("compares answers whatever the key order of nested songs (as returned by Postgres)", () => {
    expect(answersKey({ songs: [{ title: "One", id: A, artist: "X" }] })).toBe(answersKey({ songs: [{ id: A, artist: "X", title: "One" }] }));
    expect(answersKey({ songs: [{ id: A }, { id: B }] })).not.toBe(answersKey({ songs: [{ id: B }, { id: A }] }));
  });
});

describe("paste a list", () => {
  it("reads Artist - Title with hyphen, en or em dash; skips blanks and numbering", () => {
    const rows = parsePastedList("1. Daft Punk - One More Time\n\n- ABBA – Dancing Queen\nQueen — Don't Stop Me Now\n", ids);
    expect(rows.map((r) => [r.artist, r.title, r.flag])).toEqual([
      ["Daft Punk", "One More Time", null],
      ["ABBA", "Dancing Queen", null],
      ["Queen", "Don't Stop Me Now", null],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 3, 4]);
    expect(rows.every((r) => pastedRowProblem(r) === null)).toBe(true);
  });

  it("flags ambiguous lines instead of guessing, until corrected or confirmed", () => {
    const [noDash, twoDashes, hyphenated] = parsePastedList("Wonderwall\nJay-Z - Song - Remix\nAnti-Hero", ids);
    expect(noDash).toMatchObject({ artist: "", title: "Wonderwall" });
    expect(noDash.flag).toMatch(/add the artist/);
    expect(pastedRowProblem(noDash)).toBe('No " - " found: add the artist.');
    expect(pastedRowProblem({ ...noDash, checked: true })).toBe("Enter the artist.");
    expect(pastedRowProblem({ ...noDash, artist: "Oasis", checked: true })).toBeNull();
    expect(twoDashes).toMatchObject({ artist: "Jay-Z", title: "Song - Remix" });
    expect(pastedRowProblem(twoDashes)).toMatch(/Looks right/);
    expect(pastedRowProblem({ ...twoDashes, checked: true })).toBeNull();
    // A hyphen inside a word is not a separator.
    expect(hyphenated).toMatchObject({ artist: "", title: "Anti-Hero" });
  });

  it("gives every row its own id up front, so a repeated import reuses the same ids", () => {
    const rows = parsePastedList("A - One\nB - Two", ids);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe("likely duplicates and play / do-not-play conflicts", () => {
  it("matches ignoring case and spacing only", () => {
    expect([...duplicateIds([song(A, "One  More Time", "Daft Punk"), song(B, "one more time", " daft punk ")])]).toEqual([B]);
    expect(duplicateIds([song(A, "One More Time", "Daft Punk"), song(B, "One More Time (Live)", "Daft Punk")]).size).toBe(0);
  });

  it("warns across play lists and Do not play, in both directions, without changing anything", () => {
    const lists: SavedList[] = [
      { itemId: "must", key: "must_play", label: "Must play", editor: "music_requests", songs: [{ id: A, title: "Macarena", artist: "Los del Rio" }] },
      { itemId: "first", key: "first_dance", label: "First dance", editor: "moment_songs", songs: [] },
      { itemId: "dnp", key: "do_not_play", label: "Do not play", editor: "music_exclusions", songs: [{ id: B, title: "MACARENA", artist: "los del rio" }] },
    ];
    expect(conflictsFor("must", "music_requests", lists[0].songs, lists).get(A)).toEqual(["Do not play"]);
    expect(conflictsFor("dnp", "music_exclusions", lists[2].songs, lists).get(B)).toEqual(["Must play"]);
    expect(conflictsFor("first", "moment_songs", [{ id: A, title: "Other", artist: "X" }], lists).size).toBe(0);
  });
});

describe("view compatibility", () => {
  it("a database without music editors (app deployed first) still parses, with no songs", async () => {
    const { staffPlanningViewSchema } = await import("@/lib/planning/view");
    const progress = { scope: "available_sections_only", items: [], requirements_total: 0, requirements_met: 0, percent: null, available_sections: 0, complete_sections: 0, unavailable_sections: 0 };
    const view = staffPlanningViewSchema.parse({
      plan: { id: A, origin: "template", initialized_via: "booking", created_at: "2026-10-05T00:00:00Z", source_template_id: null, source_template_name: null, structure_version: 1 },
      structure: { general: [], stages: [] },
      basics: { item_id: B, answers: {}, revision: 0, updated_by: null, updated_at: null },
      stage_details: {}, timeline_warnings: [], imported: null, progress,
    });
    expect("plan" in view && view.plan !== null && view.music).toEqual({});
    expect("plan" in view && view.plan !== null && view.moments).toEqual({});
  });
});
