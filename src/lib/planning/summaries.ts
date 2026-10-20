import { ANNOUNCEMENT_LANGUAGES } from "./basics";
import { GENRES, INTERACTION_LABELS, LYRICS, SLOW_SONGS, roleLabel, type EventContact } from "./contacts";
import { isMusicEditor, type MusicEditor } from "./music";
import { grandEntranceOf, isStageEditor } from "./stages";
import { TIMED_RULES, type TimedEditor } from "./timed";

/**
 * One-line previews of planning answers, for collapsed questions and the
 * overview: what the client entered, in their words, never a status. The
 * input is an item's answers exactly as its editor saves them (the same
 * shape whether they come from the database or from the editor's current,
 * possibly unsaved, form), so a preview is never a second source of truth.
 * Nothing is invented: an empty answer has no preview (null), and a partial
 * one shows only what is there; whether it is complete is the status's job.
 */

export type SummaryContext = {
  /** The business's display name (the DJ as clients know them). */
  djName: string;
  /** The DJ handling the event, when named (events.dj_name, else tenants.dj_name). */
  djDisplayName?: string | null;
  /** The event venue, for "Same as the event venue". */
  venueName?: string | null;
  /** Event contacts the day-of contact can point at. */
  eventContacts?: EventContact[];
  /** Who reads it: the client (default) or staff, for "To discuss with your DJ" and "(your DJ)". */
  audience?: "client" | "staff";
};

type Answers = Record<string, unknown>;

export const DISCUSS = "To discuss with your DJ";
const STAFF_DISCUSS = "To discuss with the client";
const SEP = " · ";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): Answers[] => (Array.isArray(v) ? v.filter((x): x is Answers => typeof x === "object" && x !== null) : []);
const labelOf = (options: readonly (readonly [string, string])[], value: unknown): string | undefined => options.find(([v]) => v === value)?.[1];
const join = (parts: (string | null | undefined | false)[]): string | null => {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join(SEP) : null;
};
/** "4 songs", "1 song". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** "Maria, Tom +2 more": the first `shown` names, then how many more. */
export function names(values: string[], shown = 2): string | null {
  const kept = values.map((v) => v.trim()).filter(Boolean);
  if (kept.length === 0) return null;
  const head = kept.slice(0, shown).join(", ");
  return kept.length > shown ? `${head} +${kept.length - shown} more` : head;
}
/** Option labels written as the end of a sentence ("Not sure yet — discuss with the DJ" reads as the discuss preview). */
const choice = (options: readonly (readonly [string, string])[], value: unknown): string | null =>
  value === "discuss" ? null : (labelOf(options, value) ?? null);

/** "16:30" as "4:30 p.m."; with the next-day mark, "1:00 a.m. (next day)". Invalid input reads as nothing. */
export function clock(time: unknown, nextDay?: unknown): string | null {
  const t = str(time);
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const text = `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${hour < 12 ? "a.m." : "p.m."}`;
  return nextDay === true ? `${text} (next day)` : text;
}

/** "4:00 p.m.–5:00 p.m.", or the start alone. */
function span(a: Answers, prefix: string, endPrefix = "end"): string | null {
  const start = clock(a[`${prefix}_time`], a[`${prefix}_next_day`]);
  const end = clock(a[`${endPrefix}_time`], a[`${endPrefix}_next_day`]);
  if (start && end) return `${start}–${end}`;
  return start ?? (end ? `Until ${end}` : null);
}

/** A song as "Title · Artist" (either part alone when that is all there is). */
export function songLine(s: Answers): string | null {
  return join([str(s.title), str(s.artist)]);
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

const MUSIC_CHOICE: Record<string, string> = { dj_choice: "DJ's choice", not_applicable: "Not happening", discuss: DISCUSS };

export function musicSummary(editor: MusicEditor, a: Answers): string | null {
  const songs = list(a.songs);
  const playlists = list(a.playlists);
  if (a.choice === "none") return editor === "music_exclusions" ? "Nothing to avoid" : "No requests";
  if (typeof a.choice === "string" && MUSIC_CHOICE[a.choice] && songs.length === 0 && playlists.length === 0) return MUSIC_CHOICE[a.choice];
  // A moment's song (first dance, last song): the song itself. Lists: how much is in them.
  if (playlists.length === 0 && songs.length > 0 && (editor === "moment_songs" || songs.length === 1)) {
    const first = songLine(songs[0]);
    return first && songs.length > 1 ? `${first} +${songs.length - 1} more` : first;
  }
  return join([songs.length > 0 && count(songs.length, "song"), playlists.length > 0 && count(playlists.length, "playlist")]);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** The music part of a moment with people (Processional, introductions). */
function peopleMusic(a: Answers): string | null {
  const songs = list(a.songs);
  if (songs.length > 0) return count(songs.length, "song");
  if (a.choice === "dj_choice") return "DJ's choice of music";
  if (a.choice === "discuss") return "Music to discuss";
  return null;
}

export function processionalSummary(a: Answers): string | null {
  if (a.choice === "not_applicable") return "Not happening";
  const people = list(a.participants);
  const who = people.length > 0 ? `${count(people.length, "entry", "entries")} walking in` : a.participants_choice === "discuss" ? "Who walks in: to discuss" : null;
  return join([who, peopleMusic(a)]);
}

export function introductionsSummary(a: Answers): string | null {
  if (a.choice === "none") return "No introductions";
  const entries = list(a.entries);
  if (entries.length === 0 && a.choice === "discuss") return DISCUSS;
  return join([entries.length > 0 && count(entries.length, "introduction"), peopleMusic({ songs: a.songs })]);
}

export function speechesSummary(a: Answers): string | null {
  if (a.choice === "none") return "No speeches";
  const entries = list(a.entries);
  if (entries.length === 0) return a.choice === "discuss" ? DISCUSS : null;
  return join([count(entries.length, "speech", "speeches"), names(entries.map((e) => str(e.speaker)))]);
}

export function mcSummary(a: Answers, ctx: SummaryContext): string | null {
  const dj = str(ctx.djDisplayName) || ctx.djName;
  const name = str(a.name);
  switch (a.mc) {
    case "dj":
      return ctx.audience === "staff" ? `${dj} (DJ)` : `${dj} (your DJ)`;
    case "other":
      return name || "Someone else";
    case "shared":
      return `${dj} + ${name || "another MC"}`;
    case "none":
      return "No MC";
    case "discuss":
      return DISCUSS;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Timed lists (program, activities, dedications) and arrival
// ---------------------------------------------------------------------------

const TIMED_NOUN: Record<TimedEditor, [string, string]> = {
  program: ["agenda item", "agenda items"],
  activities: ["activity", "activities"],
  dedications: ["dedication", "dedications"],
};

export function timedSummary(editor: TimedEditor, a: Answers): string | null {
  const entries = list(a.entries);
  const start = editor === "program" ? span(a, "start") : null;
  if (entries.length === 0) {
    if (a.choice === "none") return join([start, editor === "activities" ? "No activities" : editor === "dedications" ? "No dedications" : "No agenda"]);
    return join([start, a.choice === "discuss" ? DISCUSS : null]);
  }
  const [one, many] = TIMED_NOUN[editor];
  const label = names(entries.map((e) => str(e[TIMED_RULES[editor].name])));
  // One entry reads as itself; several lead with how many.
  return join([start, entries.length === 1 ? label : count(entries.length, one, many), entries.length === 1 ? null : label]);
}

export function arrivalSummary(a: Answers, ctx: SummaryContext): string | null {
  if (a.arrival_none === true) return "No separate arrival arrangements";
  const where =
    a.location_source === "event_venue" ? str(ctx.venueName) || "At the event venue"
    : a.location_source === "ceremony" ? "Where the ceremony is"
    : a.location_source === "other" ? str(a.location_other) || null
    : null;
  const when = a.time_source === "ceremony" ? "Ceremony arrival time" : span(a, "start");
  return join([where, str(a.location_area) || null, when]);
}

// ---------------------------------------------------------------------------
// General sections
// ---------------------------------------------------------------------------

export function contactsSummary(a: Answers, ctx: SummaryContext): string | null {
  const vendors = list(a.vendors);
  const dayOf =
    a.day_of_source === "other" ? str(a.day_of_name)
    : a.day_of_source === "event_contact" ? (ctx.eventContacts?.find((c) => c.id === a.day_of_client_id)?.name ?? "")
    : "";
  const roles = [...new Set(vendors.map((v) => roleLabel(String(v.role ?? ""))))];
  return join([
    dayOf ? `Day-of: ${dayOf}` : a.day_of_source === "undecided" ? "Day-of contact: to decide" : null,
    vendors.length > 0 ? `${count(vendors.length, "vendor")}: ${names(roles, 2)}` : a.vendors_choice === "none" ? "No vendors" : null,
  ]);
}

export function preferencesSummary(a: Answers): string | null {
  const open = ["interaction", "lyrics", "requests"].filter((k) => a[k] === "discuss").length;
  // "Minimal" is the option's label beside its question; alone it needs its noun.
  const interaction = a.interaction === "music_mostly" ? "Minimal interaction" : choice(INTERACTION_LABELS, a.interaction);
  const requests = a.requests === "welcome" ? "Guest requests welcome" : a.requests === "not_welcome" ? "No guest requests" : null;
  return join([interaction, choice(LYRICS, a.lyrics), requests, open > 0 ? `${open} to discuss` : null]);
}

export function musicStyleSummary(a: Answers): string | null {
  const genres = Array.isArray(a.genres) ? a.genres.map((g) => labelOf(GENRES, g)).filter((g): g is string => Boolean(g)) : [];
  const style = a.style_choice === "dj_choice" ? "DJ's choice" : names([...genres, str(a.other_style)], 3);
  const slowLabel = labelOf(SLOW_SONGS, a.slow_songs);
  const slow = a.slow_songs === "discuss" ? "Slow songs: to discuss" : slowLabel ? `Slow songs: ${slowLabel.charAt(0).toLowerCase()}${slowLabel.slice(1)}` : null;
  return join([style, slow]);
}

export function basicsSummary(a: Answers): string | null {
  const guests = typeof a.guest_count === "number" ? count(a.guest_count, "guest") : null;
  const language = labelOf(ANNOUNCEMENT_LANGUAGES, a.announcement_language);
  return join([span(a, "start"), guests, language ? `Announcements: ${language}` : null]);
}

// ---------------------------------------------------------------------------
// Stage details
// ---------------------------------------------------------------------------

const MEAL: Record<string, string> = { plated: "Plated", buffet: "Buffet", family_style: "Family style", stations: "Food stations", other: "Other meal style" };

export function stageSummary(editor: string, a: Answers, ctx: SummaryContext): string | null {
  const where = a.location_source === "event_venue" ? str(ctx.venueName) || "At the event venue" : a.location_source === "other" ? str(a.location_other) || null : null;
  const area = str(a.location_area) || null;
  switch (editor) {
    case "stage_ceremony":
      return join([where, area, span(a, "start"), a.microphones === "discuss" ? "Microphones: to discuss" : null]);
    case "stage_cocktail":
      return join([where, area, span(a, "start")]);
    case "stage_entrance": {
      const g = grandEntranceOf(a);
      const entrance = g === "planned" ? (clock(a.entrance_time, a.entrance_next_day) ? `Grand entrance at ${clock(a.entrance_time, a.entrance_next_day)}` : "Grand entrance planned") : g === "none" ? "No grand entrance" : g === "undecided" ? "Grand entrance: not sure yet" : null;
      const entry = clock(a.guest_entry_time, a.guest_entry_next_day);
      return join([area, entry && `Guests enter at ${entry}`, entrance]);
    }
    case "stage_dinner": {
      const guests = a.guest_count_source === "number" && typeof a.guest_count === "number" ? count(a.guest_count, "guest") : null;
      return join([where, span(a, "start"), MEAL[str(a.meal_style)], guests]);
    }
    case "stage_party":
      return join([where, span(a, "start"), typeof a.evening_guests === "number" && a.evening_guests > 0 ? `${count(a.evening_guests, "evening guest")}` : null]);
    case "stage_closing":
      return a.finish_source === "basics_end" ? "Ends with the event" : a.finish_source === "discuss" ? "End time: to discuss" : clock(a.finish_time, a.finish_next_day) ? `Ends at ${clock(a.finish_time, a.finish_next_day)}` : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The preview for one item, chosen by its library editor (never its label).
 * Null when nothing is entered yet or the editor has no preview.
 */
export function answerSummary(editor: string | null | undefined, answers: Answers | null | undefined, ctx: SummaryContext): string | null {
  const text = summaryFor(editor, answers, ctx);
  return text !== null && ctx.audience === "staff" ? text.replace(DISCUSS, STAFF_DISCUSS) : text;
}

function summaryFor(editor: string | null | undefined, answers: Answers | null | undefined, ctx: SummaryContext): string | null {
  if (!editor || !answers || Object.keys(answers).length === 0) return null;
  if (isMusicEditor(editor)) return musicSummary(editor, answers);
  if (isStageEditor(editor)) return stageSummary(editor, answers, ctx);
  switch (editor) {
    case "processional":
      return processionalSummary(answers);
    case "introductions":
      return introductionsSummary(answers);
    case "speeches":
      return speechesSummary(answers);
    case "mc":
      return mcSummary(answers, ctx);
    case "program":
    case "activities":
    case "dedications":
      return timedSummary(editor, answers);
    case "arrival":
      return arrivalSummary(answers, ctx);
    case "contacts":
      return contactsSummary(answers, ctx);
    case "preferences":
      return preferencesSummary(answers);
    case "music_style":
      return musicStyleSummary(answers);
    case "basics":
      return basicsSummary(answers);
    default:
      return null;
  }
}
