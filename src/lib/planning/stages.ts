/**
 * Stage detail editors. The database (private.planning_editor_fields and
 * private.normalize_plan_stage) is authoritative; this mirrors it so a field
 * can be pointed at before saving, and so saved and current answers compare
 * equal. Editors are chosen by library key, never by label.
 *
 * Times are local to the event's time zone ("HH:MM"), each with an explicit
 * "next day" mark (X_time, X_next_day). Within a stage the end must come
 * after the start once next-day marks apply.
 */

import { MUSIC_RULES, isMusicEditor } from "./music";

export const STAGE_EDITORS = ["stage_ceremony", "stage_cocktail", "stage_entrance", "stage_dinner", "stage_party", "stage_closing"] as const;
export type StageEditor = (typeof STAGE_EDITORS)[number];
export function isStageEditor(editor: string | null | undefined): editor is StageEditor {
  return (STAGE_EDITORS as readonly string[]).includes(editor ?? "");
}

type Stored =
  | { kind: "text"; max: number }
  | { kind: "choice"; choices: readonly string[] }
  | { kind: "time" }
  | { kind: "next_day" }
  | { kind: "flag" }
  | { kind: "int"; min: number; max: number };

const location = {
  location_source: { kind: "choice", choices: ["event_venue", "other"] },
  location_other: { kind: "text", max: 500 },
  location_area: { kind: "text", max: 200 },
} as const;
const time = (prefix: string) => ({ [`${prefix}_time`]: { kind: "time" }, [`${prefix}_next_day`]: { kind: "next_day" } }) as Record<string, Stored>;
const instructions = { instructions: { kind: "text", max: 2000 } } as const;

export const STAGE_FIELDS: Record<StageEditor, Record<string, Stored>> = {
  stage_ceremony: {
    ...location, ...time("guest_arrival"), ...time("start"), ...time("end"),
    officiant_name: { kind: "text", max: 200 },
    officiant_contact: { kind: "text", max: 200 },
    microphones: { kind: "choice", choices: ["not_needed", "needed", "discuss"] },
    microphone_notes: { kind: "text", max: 500 },
    ...instructions,
  },
  stage_cocktail: { ...location, ...time("start"), ...time("end"), atmosphere: { kind: "text", max: 1000 }, ...instructions },
  // "entrance_none" (older answers) is read as grand_entrance "none" and never written again.
  stage_entrance: {
    ...time("guest_entry"),
    location_area: { kind: "text", max: 200 },
    grand_entrance: { kind: "choice", choices: ["planned", "none", "undecided"] },
    ...time("entrance"),
  },
  stage_dinner: {
    ...location, ...time("start"), ...time("end"),
    meal_style: { kind: "choice", choices: ["plated", "buffet", "family_style", "stations", "other"] },
    guest_count_source: { kind: "choice", choices: ["basics", "number"] },
    guest_count: { kind: "int", min: 1, max: 5000 },
  },
  stage_party: { ...location, ...time("start"), ...time("end"), evening_guests: { kind: "int", min: 0, max: 5000 } },
  stage_closing: {
    finish_source: { kind: "choice", choices: ["time", "basics_end", "discuss"] },
    ...time("finish"),
    closing_instructions: { kind: "text", max: 2000 },
  },
};

export type StageAnswers = Record<string, string | number | true>;
export type StageForm = Record<string, string | boolean>;

export function stageFormFromAnswers(editor: StageEditor, answers: StageAnswers): StageForm {
  const form: StageForm = {};
  for (const [field, def] of Object.entries(STAGE_FIELDS[editor])) {
    const value = answers[field];
    form[field] = def.kind === "flag" || def.kind === "next_day" ? value === true : value === undefined ? "" : String(value);
  }
  if (editor === "stage_entrance") form.grand_entrance = grandEntranceOf(answers) ?? "";
  return form;
}

// ---------------------------------------------------------------------------
// The grand entrance decision (Reception entrance)
// ---------------------------------------------------------------------------

export type GrandEntrance = "planned" | "none" | "undecided";

/**
 * The grand entrance decision as saved, older answers included (mirrors
 * private.plan_grand_entrance): the explicit choice; else "No formal
 * entrance" means none and an entrance time means planned; else null.
 */
export function grandEntranceOf(a: Record<string, unknown>): GrandEntrance | null {
  const g = a.grand_entrance;
  if (g === "planned" || g === "none" || g === "undecided") return g;
  if (a.entrance_none === true) return "none";
  if (typeof a.entrance_time === "string") return "planned";
  return null;
}

/** Moments that belong to the grand entrance: shown and counted only while it's planned. */
export const GRAND_ENTRANCE_MOMENTS = ["introductions", "entrance_music"];

/**
 * Whether the grand entrance's moments are offered (mirrors private.plan_progress):
 * while it's planned, or before any decision when they already hold answers
 * (plans started before the question existed).
 */
export function grandEntranceOpen(decision: GrandEntrance | null, saved: boolean): boolean {
  return decision === "planned" || (decision === null && saved);
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Minutes from the start of the event day, next-day mark included, or null. */
export function minutesOf(a: Record<string, unknown>, prefix: string): number | null {
  const t = a[`${prefix}_time`];
  if (typeof t !== "string" || !TIME.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m + (a[`${prefix}_next_day`] === true ? 1440 : 0);
}

export function stageAnswersFromForm(editor: StageEditor, form: StageForm): { ok: true; answers: StageAnswers } | { ok: false; field: string; message: string } {
  const answers: StageAnswers = {};
  for (const [field, def] of Object.entries(STAGE_FIELDS[editor])) {
    const raw = form[field];
    if (def.kind === "flag" || def.kind === "next_day") {
      if (raw === true) answers[field] = true;
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") continue;
    if (def.kind === "text") {
      if (value.length > def.max) return { ok: false, field, message: `Keep this under ${def.max.toLocaleString("en-CA")} characters.` };
      answers[field] = value;
    } else if (def.kind === "choice") {
      if (!def.choices.includes(value)) return { ok: false, field, message: "Choose an option from the list." };
      answers[field] = value;
    } else if (def.kind === "time") {
      if (!TIME.test(value)) return { ok: false, field, message: "Enter a time such as 18:30." };
      answers[field] = value;
    } else if (def.kind === "int") {
      if (!/^[0-9]{1,4}$/.test(value) || Number(value) < def.min || Number(value) > def.max) {
        return { ok: false, field, message: `Enter a whole number from ${def.min} to ${def.max.toLocaleString("en-CA")}.` };
      }
      answers[field] = Number(value);
    }
  }
  for (const field of Object.keys(answers)) {
    if (field.endsWith("_next_day") && !(field.replace(/_next_day$/, "_time") in answers)) delete answers[field];
  }
  const start = minutesOf(answers, "start");
  const end = minutesOf(answers, "end");
  if (start !== null && end !== null && end <= start) {
    return { ok: false, field: "end_time", message: 'The end must be after the start. If it ends after midnight, check "Next day".' };
  }
  return { ok: true, answers };
}

// ---------------------------------------------------------------------------
// Layout and wording
// ---------------------------------------------------------------------------

export type Block =
  | { type: "location"; label: string }
  | { type: "time"; prefix: string; label: string; hint?: string }
  | { type: "text"; field: string; label: string; rows?: number; hint?: string; placeholder?: string }
  | { type: "choice"; field: string; label: string; options: [string, string][]; hint?: string }
  | { type: "int"; field: string; label: string; hint?: string }
  | { type: "flag"; field: string; label: string }
  | { type: "guest_count" }
  | { type: "finish" }
  | { type: "grand_entrance" }
  | { type: "note"; text: string };

export const EQUIPMENT_NOTE =
  "Equipment answers are planning information for your DJ to review. They don't change the contracted package, gear or price.";

const instructionsBlock: Block = { type: "text", field: "instructions", label: "Instructions for the DJ (optional)", rows: 3 };

export const STAGE_LAYOUT: Record<StageEditor, Block[]> = {
  stage_ceremony: [
    { type: "location", label: "Where is the ceremony?" },
    { type: "time", prefix: "guest_arrival", label: "Guest arrival (needed)" },
    { type: "time", prefix: "start", label: "Ceremony start (needed)" },
    { type: "time", prefix: "end", label: "Ceremony end (optional)" },
    { type: "text", field: "officiant_name", label: "Officiant name (optional)" },
    { type: "text", field: "officiant_contact", label: "Officiant phone or email (optional)", hint: "Only if the DJ may need to coordinate with them." },
    {
      type: "choice", field: "microphones", label: "Microphones (needed)",
      options: [["not_needed", "Not needed"], ["needed", "Needed"], ["discuss", "Not sure, discuss with DJ"]],
      hint: EQUIPMENT_NOTE,
    },
    { type: "text", field: "microphone_notes", label: "Who will speak? (optional)", hint: "For example: officiant, two readers, vows." },
    instructionsBlock,
  ],
  stage_cocktail: [
    { type: "location", label: "Where is the cocktail?" },
    { type: "time", prefix: "start", label: "Cocktail start (needed)" },
    { type: "time", prefix: "end", label: "Cocktail end (optional)" },
    { type: "text", field: "atmosphere", label: "Atmosphere or music style (optional)", rows: 2, hint: "For example: light jazz, acoustic covers, upbeat lounge." },
    instructionsBlock,
  ],
  stage_entrance: [
    {
      type: "time", prefix: "guest_entry", label: "When will guests enter the reception space? (needed)",
      hint: "Approximately when guests will be invited into the room or area where the reception takes place.",
    },
    {
      type: "text", field: "location_area", label: "Where will the reception take place? (optional)",
      placeholder: "Main hall, tent, or dinner area", hint: "No need for a formal room name.",
    },
    { type: "grand_entrance" },
  ],
  stage_dinner: [
    { type: "location", label: "Where is dinner?" },
    { type: "time", prefix: "start", label: "Dinner start (needed)" },
    { type: "time", prefix: "end", label: "Dinner end (optional)" },
    {
      type: "choice", field: "meal_style", label: "Meal style (optional)",
      options: [["plated", "Plated"], ["buffet", "Buffet"], ["family_style", "Family style"], ["stations", "Food stations"], ["other", "Other"]],
    },
    { type: "guest_count" },
  ],
  stage_party: [
    { type: "location", label: "Where is the party?" },
    { type: "time", prefix: "start", label: "Party start (needed)" },
    { type: "time", prefix: "end", label: "Party end (optional)" },
    { type: "int", field: "evening_guests", label: "Additional evening guests (optional)", hint: "Guests coming for the party only. 0 if none." },
  ],
  stage_closing: [
    { type: "finish" },
    { type: "text", field: "closing_instructions", label: "Closing instructions (optional)", rows: 3, hint: "For example: lights up slowly, last-call announcement, send-off." },
  ],
};

export const STAGE_REQUIREMENT_LABELS: Record<string, string> = {
  location: "Location",
  guest_arrival: "Guest arrival time",
  start_time: "Start time",
  microphones: "Microphone needs",
  guest_entry: "Guest entry time",
  grand_entrance: "Formal grand entrance",
  entrance: "Planned grand entrance time",
  guest_count: "Guest count",
  finish: "Finish time",
  songs: "Songs or a choice",
  participants: "Who walks in",
  mc: "MC",
  introductions: "Who is introduced, or a choice",
  entry_music: "A song or DJ's choice for everyone introduced",
  speeches: "Speeches or a choice",
  day_of: "Day-of contact with a phone",
  vendors: "Vendor contacts, or none",
  interaction: "DJ interaction",
  language: "Announcement language",
  lyrics: "Explicit lyrics",
  requests: "Guest requests",
  style: "Music styles, or DJ's choice",
  slow_songs: "Slow songs",
  arrival_time: "Arrival time",
  program: "Agenda, or a choice",
  activities: "Activities, or a choice",
  dedications: "Dedications, or a choice",
};

/**
 * How a requirement reads in checklists and run-sheet notes. The music lists
 * that take playlists (MUSIC_RULES) say so; song moments keep "Songs or a
 * choice". `editor` is the item's editor, when known.
 */
export function requirementLabel(key: string, editor?: string | null): string | undefined {
  if (key === "songs" && isMusicEditor(editor) && MUSIC_RULES[editor].playlists) return "Songs, playlists or a choice";
  return STAGE_REQUIREMENT_LABELS[key];
}

export const REQUIREMENT_NOTES: Record<string, string> = {
  venue_unknown: "No event venue yet",
  basics_missing: "Not in Event basics yet",
  timing_open: "A speech has no time or cue yet",
  not_decided: "Not decided yet",
  phone_missing: "No phone number yet",
  contact_unavailable: "That contact isn't on this event any more",
  ceremony_missing: "Not in the Ceremony details yet",
  entry_timing_open: "An entry has no time or moment yet",
  dedication_open: "A dedication still needs a song or timing",
  music_open: "Someone's music isn't decided yet",
};

/** Times before this are often after midnight, so the next-day mark is offered for them. */
export const SMALL_HOURS_END = "06:00";

/**
 * Whether a time field shows its "Next day" mark. Most times are on the event
 * day, so the mark stays out of the way unless it's already set, the time is
 * in the small hours, the caller suggests it (an end that isn't after its
 * start) or the field has an error to fix. Never inferred: the client checks it.
 */
export function offersNextDay(time: string, nextDay: boolean, opts: { suggest?: boolean; error?: boolean } = {}): boolean {
  return nextDay || Boolean(opts.suggest) || Boolean(opts.error) || (TIME.test(time) && time < SMALL_HOURS_END);
}

/** "Sun, Aug 15" for the day after the event date. */
export function nextDayLabel(eventDate: string): string {
  const [y, m, d] = eventDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d + 1)));
}
