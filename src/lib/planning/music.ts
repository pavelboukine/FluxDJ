import { isHttpsUrl } from "@/lib/payments";
import { UUID_RE } from "@/lib/forms";

/**
 * Manual song entry. The database (private.normalize_plan_music and
 * private.plan_music_requirements) is authoritative; this mirrors it so a
 * field can be pointed at before saving and saved and current answers compare
 * equal. Editors are chosen by library key, never by label. No music service:
 * nothing here identifies recordings; matching only ignores case and spacing.
 */

export const MUSIC_EDITORS = ["music_background", "music_requests", "music_exclusions", "moment_songs"] as const;
export type MusicEditor = (typeof MUSIC_EDITORS)[number];
export function isMusicEditor(editor: string | null | undefined): editor is MusicEditor {
  return (MUSIC_EDITORS as readonly string[]).includes(editor ?? "");
}

export type MusicChoice = "dj_choice" | "none" | "not_applicable" | "discuss";

export const MUSIC_RULES: Record<MusicEditor, { choices: MusicChoice[]; maxSongs: number; cue: boolean; paste: boolean }> = {
  music_background: { choices: ["dj_choice"], maxSongs: 150, cue: false, paste: true },
  music_requests: { choices: ["none"], maxSongs: 150, cue: false, paste: true },
  music_exclusions: { choices: ["none"], maxSongs: 150, cue: false, paste: true },
  moment_songs: { choices: ["dj_choice", "not_applicable", "discuss"], maxSongs: 12, cue: true, paste: false },
};

export const SONG_LIMITS = { title: 200, artist: 200, version: 100, cue: 80, notes: 500, link: 1000 } as const;
type SongField = keyof typeof SONG_LIMITS;

export type Song = { id: string; title: string; artist: string; version?: string; link?: string; notes?: string; cue?: string };
export type MusicAnswers = { songs?: Song[]; choice?: MusicChoice };
/** Form state: every field a string (empty when unset); choice "" means "I'll list the songs". */
export type SongForm = { id: string; title: string; artist: string; version: string; link: string; notes: string; cue: string };
export type MusicForm = { songs: SongForm[]; choice: MusicChoice | "" };

export function emptySong(id: string): SongForm {
  return { id, title: "", artist: "", version: "", link: "", notes: "", cue: "" };
}

export function musicFormFromAnswers(answers: MusicAnswers): MusicForm {
  return {
    songs: (answers.songs ?? []).map((s) => ({ ...emptySong(s.id), ...s })),
    choice: answers.choice ?? "",
  };
}

export const songField = (id: string, field: string) => `song:${id}:${field}`;

export function musicAnswersFromForm(editor: MusicEditor, form: MusicForm): { ok: true; answers: MusicAnswers } | { ok: false; field: string; message: string } {
  const rules = MUSIC_RULES[editor];
  if (form.songs.length > rules.maxSongs) return { ok: false, field: "songs", message: `Keep this list to ${rules.maxSongs} songs or fewer.` };
  const songs: Song[] = [];
  const ids = new Set<string>();
  for (const s of form.songs) {
    if (!UUID_RE.test(s.id) || ids.has(s.id)) return { ok: false, field: "songs", message: "Reload the page and try again." };
    ids.add(s.id);
    const out: Song = { id: s.id, title: "", artist: "" };
    for (const field of Object.keys(SONG_LIMITS) as SongField[]) {
      if (field === "cue" && !rules.cue) continue;
      const value = (s[field] ?? "").trim();
      if (value.length > SONG_LIMITS[field]) return { ok: false, field: songField(s.id, field), message: `Keep this under ${SONG_LIMITS[field]} characters.` };
      if (field === "link" && value !== "" && !isHttpsUrl(value)) {
        return { ok: false, field: songField(s.id, "link"), message: "Enter a full https:// address, or leave the link empty." };
      }
      if (value !== "") out[field] = value;
    }
    if (!out.title) return { ok: false, field: songField(s.id, "title"), message: "Enter the song title." };
    if (!out.artist) return { ok: false, field: songField(s.id, "artist"), message: "Enter the artist." };
    songs.push(out);
  }
  const answers: MusicAnswers = {};
  if (form.choice) {
    if (!rules.choices.includes(form.choice)) return { ok: false, field: "choice", message: "Choose an option from the list." };
    if (form.choice !== "discuss" && songs.length > 0) {
      return { ok: false, field: "choice", message: 'Remove the songs first, or keep them and choose "I\'ll list the songs".' };
    }
    answers.choice = form.choice;
  }
  if (songs.length > 0) answers.songs = songs;
  return { ok: true, answers };
}

// ---------------------------------------------------------------------------
// Likely duplicates and play / do-not-play conflicts (informational only)
// ---------------------------------------------------------------------------

/** Case and spacing only: without a music service, nothing more can be claimed. */
export function matchKey(s: { title: string; artist: string }): string {
  const norm = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(s.title)}\u0000${norm(s.artist)}`;
}

/** Ids of songs whose title and artist repeat an earlier entry of the same list. */
export function duplicateIds(songs: { id: string; title: string; artist: string }[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of songs) {
    if (!s.title.trim() || !s.artist.trim()) continue;
    const key = matchKey(s);
    if (seen.has(key)) dupes.add(s.id);
    seen.add(key);
  }
  return dupes;
}

export type SavedList = { itemId: string; key: string; label: string; editor: MusicEditor; songs: Song[] };

/**
 * For each song of `songs`, the labels of other lists that contradict it: a
 * song to play that is also under "Do not play", or the reverse. Nothing is
 * moved or removed.
 */
export function conflictsFor(itemId: string, editor: MusicEditor, songs: { id: string; title: string; artist: string }[], lists: SavedList[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const others = lists.filter((l) => l.itemId !== itemId && (l.editor === "music_exclusions") !== (editor === "music_exclusions"));
  for (const s of songs) {
    if (!s.title.trim() || !s.artist.trim()) continue;
    const key = matchKey(s);
    const labels = others.filter((l) => l.songs.some((o) => matchKey(o) === key)).map((l) => l.label);
    if (labels.length > 0) out.set(s.id, labels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Paste a list": one song per line, "Artist - Title"
// ---------------------------------------------------------------------------

export const PASTE_MAX_LINES = 150;

/** `checked`: the user edited the row or confirmed a flagged guess. */
export type PastedRow = { id: string; line: number; text: string; artist: string; title: string; include: boolean; flag: string | null; checked: boolean };

const SEPARATOR = /\s+[-–—]\s+/;

/**
 * One song per line as "Artist - Title" (a hyphen, en dash or em dash with
 * spaces around it). Blank lines are skipped, and a leading "1." or bullet is
 * dropped. A line without exactly one separator is flagged and can't be
 * imported until the user corrects it or confirms the split shown.
 */
export function parsePastedList(text: string, newId: () => string): PastedRow[] {
  const rows: PastedRow[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\s*(?:\d{1,3}[.)]|[-*•])\s+/, "").trim();
    if (!line) return;
    const parts = line.split(SEPARATOR);
    let artist = "";
    let title = line;
    let flag: string | null = null;
    if (parts.length === 2 && parts[0] && parts[1]) {
      [artist, title] = parts.map((p) => p.trim());
    } else if (parts.length > 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
      flag = "More than one dash: check which part is the artist.";
    } else {
      flag = 'No " - " found: add the artist.';
    }
    if (artist.length > SONG_LIMITS.artist || title.length > SONG_LIMITS.title) flag = "Too long: shorten the artist or title.";
    rows.push({ id: newId(), line: index + 1, text: line, artist, title, include: true, flag, checked: false });
  });
  return rows;
}

/** Why an included pasted row can't be imported yet, or null. */
export function pastedRowProblem(row: PastedRow): string | null {
  if (!row.title.trim()) return "Enter the title.";
  if (!row.artist.trim()) return row.flag && !row.checked ? row.flag : "Enter the artist.";
  if (row.title.trim().length > SONG_LIMITS.title || row.artist.trim().length > SONG_LIMITS.artist) return "Too long: shorten the artist or title.";
  if (row.flag && !row.checked) return `${row.flag} Correct it, or tick "Looks right".`;
  return null;
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

export const CHOICE_LABELS: Record<MusicEditor, Partial<Record<MusicChoice, string>>> = {
  music_background: { dj_choice: "DJ's choice: no suggestions" },
  music_requests: { none: "No requests" },
  music_exclusions: { none: "Nothing to exclude" },
  moment_songs: { dj_choice: "DJ's choice", not_applicable: "Not applicable: this moment won't happen", discuss: "Not sure yet, discuss with the DJ" },
};

export const LIST_CHOICE_LABEL: Record<MusicEditor, string> = {
  music_background: "Song suggestions",
  music_requests: "I'll list the songs",
  music_exclusions: "I'll list the songs to avoid",
  moment_songs: "I'll list the songs",
};

/** A short explanation shown at the top of each editor, by moment key. */
export const MUSIC_HINTS: Record<string, string> = {
  couple_entrance: "The song for the couple's entrance at the ceremony.",
  entrance_music: "The one place for reception entrance songs. Use a cue label per group, for example \"Wedding party\" or \"Couple\". Who is introduced to which song goes under Introductions.",
  first_dance: "Add a second song if it's a medley, with instructions such as \"start at 0:45\" or \"fade after the chorus\".",
  family_dances: "One song per dance, with a cue label such as \"Dance with grandmother\".",
  other_dances: "One song per dance, with a cue label.",
  last_dances: "In the order they should play.",
  do_not_play: "Songs the DJ should avoid, even if guests ask.",
};

/** The page's visible song lists (Processional's songs included) with their saved songs, for warnings and song links. */
export function savedListsFrom(
  stages: { disabled: boolean; moments: { id: string; key: string; label: string; editor: string | null; disabled: boolean }[] }[],
  music: Record<string, { answers: MusicAnswers }>,
): SavedList[] {
  return stages
    .filter((s) => !s.disabled)
    .flatMap((s) => s.moments)
    .flatMap((m) => {
      const editor = m.editor === "processional" ? "moment_songs" : m.editor;
      return !m.disabled && isMusicEditor(editor) ? [{ itemId: m.id, key: m.key, label: m.label, editor, songs: music[m.id]?.answers.songs ?? [] }] : [];
    });
}
