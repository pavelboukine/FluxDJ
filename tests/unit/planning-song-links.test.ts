import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addNewSongs, emptyNewSong, emptyPerson, newSongProblem } from "@/lib/planning/participants";
import { emptyTimedEntry, timedAnswersFromForm, timedEntryProblem } from "@/lib/planning/timed";
import { buildRunSheet } from "@/lib/run-sheet/model";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { pdfLinks, pdfPageTexts } from "../support/pdf";
import { input, planView, song } from "./fixtures/run-sheet";

const LONG = `https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=${"a1b2c3d4".repeat(20)}`;

describe("a song typed in with a person (Processional, grand entrance)", () => {
  const draft = (extra = {}) => ({ ...emptyNewSong(randomUUID()), title: "September", artist: "Earth, Wind & Fire", ...extra });

  it("takes a version and a link, checked like the songs list", () => {
    expect(newSongProblem(draft({ version: "Live", link: "https://www.youtube.com/watch?v=Gs069dndIYk" }), 12)).toBeNull();
    expect(newSongProblem(draft({ link: "youtube.com/watch?v=1" }), 12)).toEqual({ field: "song_link", message: "Enter a full https:// address, or leave the link empty." });
    expect(newSongProblem(draft({ link: "http://example.com/song" }), 12)?.field).toBe("song_link");
    expect(newSongProblem(draft({ version: "x".repeat(101) }), 12)?.field).toBe("song_version");
    // An older draft without the new fields still works.
    expect(newSongProblem({ id: randomUUID(), title: "A", artist: "B", notes: "" }, 12)).toBeNull();
  });

  it("joins the songs list with its version and link, linked to the person", () => {
    const s = draft({ version: " Live ", link: ` ${LONG} `, notes: "Start at the chorus" });
    const parents = { ...emptyPerson(randomUUID()), names: "Parents", new_song: s };
    const { songs, people } = addNewSongs([], [], [parents]);
    expect(songs).toEqual([{ id: s.id, title: "September", artist: "Earth, Wind & Fire", version: "Live", link: LONG, notes: "Start at the chorus", cue: "" }]);
    expect(people[0]).toMatchObject({ song_id: s.id, music: "song", new_song: null });
  });

  it("never adds a song whose link is invalid", () => {
    const parents = { ...emptyPerson(randomUUID()), names: "Parents", new_song: draft({ link: "not a link" }) };
    const { songs, people } = addNewSongs([], [], [parents]);
    expect(songs).toEqual([]);
    expect(people[0].song_id).toBe("");
  });
});

describe("an activity's optional song", () => {
  it("is optional, keeps a link and version, and asks to remove a half-entered song", () => {
    const e = { ...emptyTimedEntry(randomUUID(), "activities"), name: "Shoe game", timing: "cue" as const, cue: "Between courses" };
    expect(timedAnswersFromForm("activities", { entries: [e], choice: "" })).toMatchObject({ ok: true });
    const withSong = { ...e, song_title: "Shoe", song_artist: "The Band", song_version: "Remix", song_link: LONG };
    const parsed = timedAnswersFromForm("activities", { entries: [withSong], choice: "" });
    expect(parsed.ok && parsed.answers.entries![0]).toMatchObject({ song_title: "Shoe", song_artist: "The Band", song_version: "Remix", song_link: LONG });
    expect(timedEntryProblem("activities", { ...e, song_title: "Shoe" })?.message).toBe("Enter the song's title and artist, or remove the song.");
  });
});

describe("run sheet song links", () => {
  const sheet = buildRunSheet(input(planView({
    stages: [
      { key: "ceremony", editor: "stage_ceremony", label: "Ceremony", moments: [
        { key: "recessional", editor: "moment_songs", label: "Recessional", answers: { songs: [song("Signed, Sealed", "Stevie Wonder", { link: "https://music.apple.com/ca/album/x/1?i=2" }), song("Bad Link", "Nobody", { link: "javascript:alert(1)" })] } },
      ] },
      { key: "dinner", editor: "stage_dinner", label: "Dinner", moments: [
        { key: "dinner_activities", editor: "activities", label: "Activities", answers: { entries: [
          { id: randomUUID(), name: "Shoe game", timing: "cue", cue: "Between courses", song_title: "Shoe", song_artist: "The Band", song_version: "Remix", song_link: LONG },
        ] } },
      ] },
    ],
  })));
  const rows = sheet.stages.flatMap((s) => s.rows);

  it("keeps https links on songs from lists and activities, and drops anything else", () => {
    const songs = rows.flatMap((r) => r.songs);
    expect(songs.find((s) => s.title === "Signed, Sealed")?.link).toBe("https://music.apple.com/ca/album/x/1?i=2");
    expect(songs.find((s) => s.title === "Bad Link")?.link).toBeUndefined();
    expect(songs.find((s) => s.title === "Shoe")).toEqual({ title: "Shoe", artist: "The Band", version: "Remix", cue: undefined, notes: undefined, link: LONG });
  });

  it("prints a short clickable link in the PDF, never the raw URL", async () => {
    const bytes = await renderRunSheetPdf(sheet, "0000AAAA");
    const text = (await pdfPageTexts(bytes)).join("\n");
    expect(text).toContain("Song link (open.spotify.com)");
    expect(text).toContain("Song link (music.apple.com)");
    expect(text).not.toContain("a1b2c3d4a1b2c3d4");
    const links = await pdfLinks(bytes);
    expect(links).toEqual(expect.arrayContaining([LONG, "https://music.apple.com/ca/album/x/1?i=2"]));
  });
});
