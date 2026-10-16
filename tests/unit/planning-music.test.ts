import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import {
  MUSIC_RULES,
  conflictsFor,
  duplicateIds,
  emptyPlaylist,
  emptySong,
  musicAnswersFromForm,
  musicFormFromAnswers,
  playlistKind,
  playlistProvider,
  playlistUrlKey,
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

describe("playlist links (mirror of private.normalize_plan_music)", () => {
  const P1 = "33333333-3333-4333-8333-333333333333";
  const P2 = "44444444-4444-4444-8444-444444444444";
  const pl = (id: string, url: string, extra = {}) => ({ ...emptyPlaylist(id), url, ...extra });
  const spotify = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc";

  it("saves trimmed playlists in order, next to songs, dropping empty optional fields", () => {
    const r = musicAnswersFromForm("music_background", {
      songs: [song(A, "One", "X")],
      playlists: [pl(P1, ` ${spotify} `, { label: " Cocktail Hour ", notes: "Relaxed" }), pl(P2, "https://music.apple.com/ca/playlist/x/pl.u-abc", { label: " " })],
      choice: "",
    });
    expect(r).toEqual({ ok: true, answers: {
      songs: [{ id: A, title: "One", artist: "X" }],
      playlists: [{ id: P1, url: spotify, label: "Cocktail Hour", notes: "Relaxed" }, { id: P2, url: "https://music.apple.com/ca/playlist/x/pl.u-abc" }],
    } });
  });

  it("a playlist alone is a complete answer for every list editor, never for song moments", () => {
    for (const editor of ["music_background", "music_requests", "music_exclusions"] as const) {
      expect(MUSIC_RULES[editor].playlists).toBe(true);
      expect(musicAnswersFromForm(editor, { songs: [], playlists: [pl(P1, spotify)], choice: "" })).toEqual({ ok: true, answers: { playlists: [{ id: P1, url: spotify }] } });
    }
    expect(MUSIC_RULES.moment_songs.playlists).toBe(false);
    expect(musicAnswersFromForm("moment_songs", { songs: [], playlists: [pl(P1, spotify)], choice: "" })).toMatchObject({ ok: false, field: "playlists" });
  });

  it("accepts any https link but refuses blanks, other schemes, credentials and malformed links", () => {
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, "https://playlists.example.org/mine")], choice: "" })).toMatchObject({ ok: true });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, "  ")], choice: "" }))
      .toEqual({ ok: false, field: `playlist:${P1}:url`, message: "Paste the playlist link." });
    for (const url of ["http://open.spotify.com/playlist/x", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "HTTPS://open.spotify.com/x",
      "https://user:pw@example.com/x", "https://example", "https://exa mple.com/x", "open.spotify.com/playlist/x", `https://example.com/${"x".repeat(990)}`]) {
      expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, url)], choice: "" }), url).toMatchObject({ ok: false, field: `playlist:${P1}:url` });
    }
  });

  it("refuses the same playlist twice in a list, whatever sharing parameters or slashes", () => {
    for (const again of [spotify, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "https://OPEN.SPOTIFY.COM/playlist/37i9dQZF1DXcBWIGoYBM5M/?utm_source=copy#x"]) {
      expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, spotify), pl(P2, again)], choice: "" }))
        .toEqual({ ok: false, field: `playlist:${P2}:url`, message: "This playlist is already added here." });
    }
    // A different playlist, or the same path on another service, is not a duplicate.
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, "https://www.youtube.com/playlist?list=PL1"), pl(P2, "https://music.youtube.com/playlist?list=PL1")], choice: "" })).toMatchObject({ ok: true });
    expect(playlistUrlKey("https://www.youtube.com/playlist?list=PL1&si=x&feature=share")).toBe("youtube.com/playlist?list=PL1&feature=share");
    expect(playlistUrlKey("javascript:alert(1)")).toBeNull();
  });

  it("bounds the list and each field, and refuses unusable ids", () => {
    const six = Array.from({ length: 6 }, (_, i) => pl(ids(), `https://example.com/p${i}`));
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: six, choice: "" })).toEqual({ ok: false, field: "playlists", message: "Keep this to 5 playlists or fewer." });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, spotify, { label: "x".repeat(101) })], choice: "" })).toMatchObject({ ok: false, field: `playlist:${P1}:label` });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, spotify, { notes: "x".repeat(501) })], choice: "" })).toMatchObject({ ok: false, field: `playlist:${P1}:notes` });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl("p1", spotify)], choice: "" })).toMatchObject({ ok: false, field: "playlists" });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, spotify), pl(P1, "https://example.com/b")], choice: "" })).toMatchObject({ ok: false, field: "playlists" });
  });

  it("refuses DJ's choice or none while playlists exist; the choices still work alone", () => {
    expect(musicAnswersFromForm("music_background", { songs: [], playlists: [pl(P1, spotify)], choice: "dj_choice" })).toMatchObject({ ok: false, field: "choice" });
    expect(musicAnswersFromForm("music_requests", { songs: [], playlists: [pl(P1, spotify)], choice: "none" })).toMatchObject({ ok: false, field: "choice" });
    expect(musicAnswersFromForm("music_exclusions", { songs: [], playlists: [], choice: "none" })).toEqual({ ok: true, answers: { choice: "none" } });
    expect(musicAnswersFromForm("music_background", { songs: [], playlists: [], choice: "dj_choice" })).toEqual({ ok: true, answers: { choice: "dj_choice" } });
  });

  it("round-trips saved playlists through the form, and legacy answers stay as they were", () => {
    const saved = { songs: [{ id: A, title: "One", artist: "X" }], playlists: [{ id: P1, url: spotify, label: "Dinner" }] };
    expect(musicAnswersFromForm("music_background", musicFormFromAnswers(saved))).toEqual({ ok: true, answers: saved });
    const legacy = { songs: [{ id: A, title: "One", artist: "X", link: "https://example.com/a" }], choice: "discuss" as const };
    expect(musicAnswersFromForm("moment_songs", musicFormFromAnswers(legacy))).toEqual({ ok: true, answers: legacy });
  });

  it("names the service from the exact host name only, for display", () => {
    expect(playlistKind(spotify)).toBe("Spotify playlist");
    expect(playlistKind("https://music.apple.com/us/playlist/wedding/pl.u-123")).toBe("Apple Music playlist");
    expect(playlistKind("https://music.youtube.com/playlist?list=PL1")).toBe("YouTube Music playlist");
    expect(playlistKind("https://www.youtube.com/playlist?list=PL1")).toBe("YouTube playlist");
    expect(playlistKind("https://music.amazon.ca/user-playlists/abc")).toBe("Amazon Music playlist");
    expect(playlistKind("https://tidal.com/browse/playlist/abc")).toBe("TIDAL playlist");
    expect(playlistKind("https://example.com/my-playlist")).toBe("Playlist link");
    for (const fake of ["https://open.spotify.com.example.net/playlist/x", "https://notspotify.com/open.spotify.com", "https://example.com/?u=music.apple.com", "https://evil-music.youtube.com.co/x"]) {
      expect(playlistProvider(fake), fake).toBeNull();
    }
  });
});

describe("requirement wording", () => {
  it("lists that take playlists say so; song moments keep their wording", async () => {
    const { requirementLabel } = await import("@/lib/planning/stages");
    for (const editor of ["music_background", "music_requests", "music_exclusions"]) expect(requirementLabel("songs", editor)).toBe("Songs, playlists or a choice");
    for (const editor of ["moment_songs", "processional", null, undefined]) expect(requirementLabel("songs", editor)).toBe("Songs or a choice");
    expect(requirementLabel("entry_music", "introductions")).toBe("A song or DJ's choice for everyone introduced");
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
    expect("plan" in view && view.plan !== null && view.event_contacts).toEqual([]);
  });

  it("keeps a list's playlists when reading the view (an editor would otherwise save them away)", async () => {
    const { staffPlanningViewSchema } = await import("@/lib/planning/view");
    const progress = { scope: "available_sections_only", items: [], requirements_total: 0, requirements_met: 0, percent: null, available_sections: 0, complete_sections: 0, unavailable_sections: 0 };
    const playlists = [{ id: B, url: "https://open.spotify.com/playlist/x", label: "Dinner", notes: "Soft" }];
    const view = staffPlanningViewSchema.parse({
      plan: { id: A, origin: "template", initialized_via: "booking", created_at: "2026-10-05T00:00:00Z", source_template_id: null, source_template_name: null, structure_version: 1 },
      structure: { general: [], stages: [] },
      basics: { item_id: B, answers: {}, revision: 0, updated_by: null, updated_at: null },
      stage_details: {}, timeline_warnings: [], imported: null, progress,
      music: { [A]: { answers: { playlists }, revision: 2 } },
    });
    expect("plan" in view && view.plan !== null && view.music[A].answers.playlists).toEqual(playlists);
  });
});
