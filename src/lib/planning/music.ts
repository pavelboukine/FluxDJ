import { isHttpsUrl } from "@/lib/payments";
import { UUID_RE } from "@/lib/forms";

/**
 * Manual song entry and playlist links. The database
 * (private.normalize_plan_music and private.plan_music_requirements) is
 * authoritative; this mirrors it so a field can be pointed at before saving
 * and saved and current answers compare equal. Editors are chosen by library
 * key, never by label. No music service: nothing here identifies recordings
 * or opens playlists; matching only ignores case and spacing.
 */

export const MUSIC_EDITORS = ["music_background", "music_requests", "music_exclusions", "moment_songs"] as const;
export type MusicEditor = (typeof MUSIC_EDITORS)[number];
export function isMusicEditor(editor: string | null | undefined): editor is MusicEditor {
  return (MUSIC_EDITORS as readonly string[]).includes(editor ?? "");
}

export type MusicChoice = "dj_choice" | "none" | "not_applicable" | "discuss";

/** `playlists`: whether the list takes playlist links (the list editors only, never song moments). */
export const MUSIC_RULES: Record<MusicEditor, { choices: MusicChoice[]; maxSongs: number; cue: boolean; playlists: boolean }> = {
  music_background: { choices: ["dj_choice"], maxSongs: 150, cue: false, playlists: true },
  music_requests: { choices: ["none"], maxSongs: 150, cue: false, playlists: true },
  music_exclusions: { choices: ["none"], maxSongs: 150, cue: false, playlists: true },
  moment_songs: { choices: ["dj_choice", "not_applicable", "discuss"], maxSongs: 12, cue: true, playlists: false },
};

export const SONG_LIMITS = { title: 200, artist: 200, version: 100, cue: 80, notes: 500, link: 1000 } as const;
type SongField = keyof typeof SONG_LIMITS;

export const PLAYLIST_LIMITS = { url: 1000, label: 100, notes: 500 } as const;
export const MAX_PLAYLISTS = 5;
type PlaylistField = keyof typeof PLAYLIST_LIMITS;

export type Song = { id: string; title: string; artist: string; version?: string; link?: string; notes?: string; cue?: string };
/** A link to a playlist the client made elsewhere. Never fetched. */
export type Playlist = { id: string; url: string; label?: string; notes?: string };
export type MusicAnswers = { songs?: Song[]; playlists?: Playlist[]; choice?: MusicChoice };
/** Form state: every field a string (empty when unset); choice "" means "I'll list the songs". */
export type SongForm = { id: string; title: string; artist: string; version: string; link: string; notes: string; cue: string };
export type PlaylistForm = { id: string; url: string; label: string; notes: string };
/** `playlists` is left out by editors whose lists can't hold any (song moments, Processional, grand entrance). */
export type MusicForm = { songs: SongForm[]; playlists?: PlaylistForm[]; choice: MusicChoice | "" };

export function emptySong(id: string): SongForm {
  return { id, title: "", artist: "", version: "", link: "", notes: "", cue: "" };
}

export function emptyPlaylist(id: string): PlaylistForm {
  return { id, url: "", label: "", notes: "" };
}

export function musicFormFromAnswers(answers: MusicAnswers): MusicForm {
  return {
    songs: (answers.songs ?? []).map((s) => ({ ...emptySong(s.id), ...s })),
    playlists: (answers.playlists ?? []).map((p) => ({ ...emptyPlaylist(p.id), ...p })),
    choice: answers.choice ?? "",
  };
}

export const songField = (id: string, field: string) => `song:${id}:${field}`;
export const playlistField = (id: string, field: string) => `playlist:${id}:${field}`;

/** The database's private.is_https_url, so the browser refuses what the database would. */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?([/?#][^\s<>"\\]*)?$/;
export function isPlaylistUrl(value: string): boolean {
  return value.length <= PLAYLIST_LIMITS.url && HTTPS_URL.test(value) && isHttpsUrl(value);
}

/**
 * How two links are compared to spot the same playlist pasted twice: host
 * without "www.", no trailing slash, no fragment and no "si" or "utm_"
 * sharing parameters. Mirrors private.playlist_url_key; null if not https.
 */
export function playlistUrlKey(url: string): string | null {
  const m = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/.exec(url.trim());
  if (!m) return null;
  let host = m[1].toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  const kept = (m[3] ? m[3].slice(1).split("&") : []).filter((p) => {
    const name = p.split("=")[0].toLowerCase();
    return p !== "" && name !== "si" && !name.startsWith("utm_");
  });
  return host + m[2].replace(/\/+$/, "") + (kept.length ? `?${kept.join("&")}` : "");
}

const PROVIDERS: Record<string, string> = {
  "open.spotify.com": "Spotify",
  "play.spotify.com": "Spotify",
  "spotify.link": "Spotify",
  "music.apple.com": "Apple Music",
  "embed.music.apple.com": "Apple Music",
  "itunes.apple.com": "Apple Music",
  "music.youtube.com": "YouTube Music",
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "tidal.com": "TIDAL",
  "listen.tidal.com": "TIDAL",
  "deezer.com": "Deezer",
  "link.deezer.com": "Deezer",
  "deezer.page.link": "Deezer",
  "soundcloud.com": "SoundCloud",
  "m.soundcloud.com": "SoundCloud",
  "on.soundcloud.com": "SoundCloud",
  "pandora.com": "Pandora",
};

/**
 * The music service a link belongs to, by its exact host name (never a
 * substring: "open.spotify.com.example.net" is not Spotify), or null.
 * For display only: it says nothing about whether the playlist exists or
 * can be opened.
 */
export function playlistProvider(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  if (/^music\.amazon\.(com|ca|co\.uk|de|fr|it|es|com\.au|com\.mx|com\.br|co\.jp|in)$/.test(host)) return "Amazon Music";
  return PROVIDERS[host] ?? null;
}

/** "Spotify playlist", or "Playlist link" for a service not recognized. */
export function playlistKind(url: string): string {
  const provider = playlistProvider(url);
  return provider ? `${provider} playlist` : "Playlist link";
}

/** Checks one playlist form; the error names the field as "playlist:<id>:<field>". */
export function checkPlaylist(p: PlaylistForm): { ok: true; playlist: Playlist } | { ok: false; field: string; message: string } {
  const out: Playlist = { id: p.id, url: "" };
  for (const field of Object.keys(PLAYLIST_LIMITS) as PlaylistField[]) {
    const value = (p[field] ?? "").trim();
    if (value.length > PLAYLIST_LIMITS[field]) return { ok: false, field: playlistField(p.id, field), message: `Keep this under ${PLAYLIST_LIMITS[field]} characters.` };
    if (field === "url" && value !== "" && !isPlaylistUrl(value)) {
      return { ok: false, field: playlistField(p.id, "url"), message: "Enter the full playlist link, starting with https://." };
    }
    if (value !== "") out[field] = value;
  }
  if (!out.url) return { ok: false, field: playlistField(p.id, "url"), message: "Paste the playlist link." };
  return { ok: true, playlist: out };
}

export function musicAnswersFromForm(editor: MusicEditor, form: MusicForm): { ok: true; answers: MusicAnswers } | { ok: false; field: string; message: string } {
  const rules = MUSIC_RULES[editor];
  if (form.songs.length > rules.maxSongs) return { ok: false, field: "songs", message: `Keep this list to ${rules.maxSongs} songs or fewer.` };
  const forms = form.playlists ?? [];
  if (forms.length > 0 && !rules.playlists) return { ok: false, field: "playlists", message: "Reload the page and try again." };
  if (forms.length > MAX_PLAYLISTS) return { ok: false, field: "playlists", message: `Keep this to ${MAX_PLAYLISTS} playlists or fewer.` };
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
  const playlists: Playlist[] = [];
  const pids = new Set<string>();
  const keys = new Set<string>();
  for (const p of forms) {
    if (!UUID_RE.test(p.id) || pids.has(p.id)) return { ok: false, field: "playlists", message: "Reload the page and try again." };
    pids.add(p.id);
    const checked = checkPlaylist(p);
    if (!checked.ok) return checked;
    const key = playlistUrlKey(checked.playlist.url)!;
    if (keys.has(key)) return { ok: false, field: playlistField(p.id, "url"), message: "This playlist is already added here." };
    keys.add(key);
    playlists.push(checked.playlist);
  }
  const answers: MusicAnswers = {};
  if (form.choice) {
    if (!rules.choices.includes(form.choice)) return { ok: false, field: "choice", message: "Choose an option from the list." };
    if (form.choice !== "discuss" && (songs.length > 0 || playlists.length > 0)) {
      return { ok: false, field: "choice", message: rules.playlists
        ? "Remove the songs and playlists first, or keep them and choose to add songs or playlists."
        : 'Remove the songs first, or keep them and choose "I\'ll list the songs".' };
    }
    answers.choice = form.choice;
  }
  if (songs.length > 0) answers.songs = songs;
  if (playlists.length > 0) answers.playlists = playlists;
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
// Wording
// ---------------------------------------------------------------------------

export const CHOICE_LABELS: Record<MusicEditor, Partial<Record<MusicChoice, string>>> = {
  music_background: { dj_choice: "DJ's choice: no suggestions" },
  music_requests: { none: "No requests" },
  music_exclusions: { none: "Nothing to exclude" },
  moment_songs: { dj_choice: "DJ's choice", not_applicable: "Not applicable: this moment won't happen", discuss: "Not sure yet, discuss with the DJ" },
};

export const LIST_CHOICE_LABEL: Record<MusicEditor, string> = {
  music_background: "Songs or playlists I'd recommend",
  music_requests: "I'll share songs or playlists",
  music_exclusions: "I'll share songs or playlists to avoid",
  moment_songs: "I'll list the songs",
};

/**
 * An invitation to share a playlist, by moment key, above a list's
 * playlists. Lists without their own wording use PLAYLIST_INTRO_DEFAULT.
 */
export const PLAYLIST_INTROS: Record<string, string> = {
  arrival_music: "Have a playlist in mind for while guests arrive? Make one in Spotify, Apple Music or your favourite music app and paste the link below. You can also add individual songs.",
  pre_ceremony_music: "Have a playlist in mind for while guests take their seats? Paste a link from Spotify, Apple Music or your favourite music app. You can also add individual songs.",
  cocktail_music: "Have a playlist that captures the vibe you're going for? Create one in Spotify, Apple Music or your favourite music app, then paste the link below. You can also add individual songs.",
  dinner_music: "Want to help set the mood for dinner? Put together a playlist in your favourite music app and share the link here. You can also add individual songs.",
  must_play: "Have songs you absolutely want to hear? Make a playlist on Spotify, Apple Music or another music service and paste the link here. You can also add songs individually.",
  play_if_possible: "Songs you'd love to hear if the moment is right? Share a playlist from your favourite music app, or add songs individually.",
  do_not_play: "Any songs you'd rather not hear? Share a playlist or list individual songs to avoid.",
};
export const PLAYLIST_INTRO_DEFAULT = "Have a playlist? Paste a link from Spotify, Apple Music or your favourite music app. You can also add individual songs.";

/** A short explanation shown at the top of each editor, by moment key. */
export const MUSIC_HINTS: Record<string, string> = {
  couple_entrance: "The song for the couple's entrance at the ceremony.",
  entrance_music: "Songs for the reception entrance. Each person or group in the grand entrance order can use one of these, or a song entered right there.",
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
