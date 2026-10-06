import { isHttpsUrl } from "@/lib/payments";
import { UUID_RE } from "@/lib/forms";
import { entryField, type ListChoice } from "./participants";

/**
 * Arrival details, Program details, Dinner / Party activities and
 * Dedications. The database (private.normalize_plan_arrival,
 * private.normalize_plan_timed and the requirement functions) is
 * authoritative; this mirrors it so a field can be pointed at before saving
 * and saved and current answers compare equal. Times are local "HH:MM" with an
 * explicit next-day mark, as for stage details.
 */

type Parsed<A> = { ok: true; answers: A } | { ok: false; field: string; message: string };
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const minutes = (t: string, nextDay: boolean) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + (nextDay ? 1440 : 0);
const END_MESSAGE = 'The end must be after the start. If it ends after midnight, check "Next day".';

function times(form: { start_time: string; start_next_day: boolean; end_time: string; end_next_day: boolean }): Parsed<Record<string, string | true>> {
  const a: Record<string, string | true> = {};
  for (const p of ["start", "end"] as const) {
    const t = form[`${p}_time`];
    if (!t) continue;
    if (!TIME.test(t)) return { ok: false, field: `${p}_time`, message: "Enter a time such as 18:30." };
    a[`${p}_time`] = t;
    if (form[`${p}_next_day`]) a[`${p}_next_day`] = true;
  }
  if (a.start_time && a.end_time && minutes(a.end_time as string, a.end_next_day === true) <= minutes(a.start_time as string, a.start_next_day === true)) {
    return { ok: false, field: "end_time", message: END_MESSAGE };
  }
  return { ok: true, answers: a };
}

function texts<F extends Record<string, unknown>>(form: F, limits: Record<string, number>, out: Record<string, unknown>): { field: string; message: string } | null {
  for (const [field, max] of Object.entries(limits)) {
    const value = String(form[field] ?? "").trim();
    if (value.length > max) return { field, message: `Keep this under ${max.toLocaleString("en-CA")} characters.` };
    if (value) out[field] = value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arrival details
// ---------------------------------------------------------------------------

export type ArrivalAnswers = {
  location_source?: "event_venue" | "ceremony" | "other"; location_other?: string; location_area?: string;
  time_source?: "time" | "ceremony"; start_time?: string; start_next_day?: true; end_time?: string; end_next_day?: true;
  welcome?: string; announcement?: string; arrival_none?: true;
};
export type ArrivalForm = {
  location_source: "" | "event_venue" | "ceremony" | "other"; location_other: string; location_area: string;
  time_source: "" | "time" | "ceremony"; start_time: string; start_next_day: boolean; end_time: string; end_next_day: boolean;
  welcome: string; announcement: string; arrival_none: boolean;
};

export function arrivalForm(a: ArrivalAnswers): ArrivalForm {
  return {
    location_source: a.location_source ?? "", location_other: a.location_other ?? "", location_area: a.location_area ?? "",
    time_source: a.time_source ?? "", start_time: a.start_time ?? "", start_next_day: a.start_next_day === true,
    end_time: a.end_time ?? "", end_next_day: a.end_next_day === true, welcome: a.welcome ?? "", announcement: a.announcement ?? "",
    arrival_none: a.arrival_none === true,
  };
}

export function arrivalAnswersFromForm(form: ArrivalForm): Parsed<ArrivalAnswers> {
  const a: Record<string, unknown> = {};
  if (form.location_source) a.location_source = form.location_source;
  if (form.time_source) a.time_source = form.time_source;
  const problem = texts(form, { location_other: 500, location_area: 200, welcome: 2000, announcement: 1000 }, a);
  if (problem) return { ok: false, ...problem };
  if (form.location_source !== "other") delete a.location_other;
  if (form.time_source !== "ceremony") {
    const t = times(form);
    if (!t.ok) return t;
    Object.assign(a, t.answers);
  }
  if (form.arrival_none) {
    if (["location_source", "location_other", "location_area", "time_source", "start_time", "end_time"].some((k) => k in a)) {
      return { ok: false, field: "arrival_none", message: 'Clear the location and times first, or uncheck "No separate arrival arrangements".' };
    }
    a.arrival_none = true;
  }
  return { ok: true, answers: a as ArrivalAnswers };
}

// ---------------------------------------------------------------------------
// Timed entries: program agenda, activities, dedications
// ---------------------------------------------------------------------------

export type TimedEditor = "program" | "activities" | "dedications";
export type Timing = "anytime" | "time" | "cue" | "undecided";

export const TIMED_RULES: Record<TimedEditor, { name: string; text: Record<string, number>; song: boolean; duration: boolean; timings: Timing[]; requiresSong: boolean }> = {
  program: { name: "title", text: { title: 200, presenter: 200, pronunciation: 300, notes: 500 }, song: false, duration: true, timings: ["time", "cue", "undecided"], requiresSong: false },
  activities: { name: "name", text: { name: 200, host: 200, participants: 300, pronunciation: 300, notes: 500 }, song: true, duration: true, timings: ["time", "cue", "undecided"], requiresSong: false },
  dedications: { name: "recipient", text: { recipient: 200, relationship: 120, pronunciation: 300, message: 1000, notes: 500 }, song: true, duration: false, timings: ["anytime", "time", "cue", "undecided"], requiresSong: true },
};
export const SONG_FIELDS = { song_title: 200, song_artist: 200, song_version: 100, song_link: 1000 } as const;

/** Every field of every timed editor, as form strings (unused ones stay empty). */
export type TimedEntryForm = {
  id: string; timing: Timing; time: string; next_day: boolean; cue: string; duration: string;
  title: string; name: string; recipient: string; presenter: string; host: string; participants: string; relationship: string;
  pronunciation: string; message: string; notes: string;
  song_title: string; song_artist: string; song_version: string; song_link: string;
};
export type TimedEntry = Record<string, string | number | true>;
export type TimedAnswers = { entries?: TimedEntry[]; choice?: ListChoice } & Record<string, unknown>;
export type TimedForm = { entries: TimedEntryForm[]; choice: ListChoice | "" };

export function emptyTimedEntry(id: string, editor: TimedEditor): TimedEntryForm {
  return {
    id, timing: editor === "dedications" ? "anytime" : "undecided", time: "", next_day: false, cue: "", duration: "",
    title: "", name: "", recipient: "", presenter: "", host: "", participants: "", relationship: "", pronunciation: "", message: "", notes: "",
    song_title: "", song_artist: "", song_version: "", song_link: "",
  };
}

export function timedForm(editor: TimedEditor, a: TimedAnswers): TimedForm {
  return {
    entries: (a.entries ?? []).map((e) => {
      const f = emptyTimedEntry(String(e.id), editor);
      for (const [k, v] of Object.entries(e)) {
        if (k === "next_day") f.next_day = v === true;
        else if (k === "duration") f.duration = String(v);
        else if (k in f) (f as Record<string, unknown>)[k] = v;
      }
      return f;
    }),
    choice: a.choice ?? "",
  };
}

/** Why an entry can't be added yet (its name), or null. Other problems are shown once it's in the list. */
export function timedEntryProblem(editor: TimedEditor, e: TimedEntryForm): { field: string; message: string } | null {
  const rules = TIMED_RULES[editor];
  const name = rules.name as keyof TimedEntryForm;
  if (!String(e[name]).trim()) return { field: rules.name, message: editor === "program" ? "Enter a title." : editor === "activities" ? "Enter the activity." : "Enter who it's for." };
  if (e.song_title.trim() || e.song_artist.trim() || e.song_version.trim() || e.song_link.trim()) {
    if (!e.song_title.trim()) return { field: "song_title", message: "Enter the song's title and artist, or clear the song." };
    if (!e.song_artist.trim()) return { field: "song_artist", message: "Enter the song's title and artist, or clear the song." };
  }
  if (e.song_link.trim() && !isHttpsUrl(e.song_link.trim())) return { field: "song_link", message: "Enter a full https:// address, or leave the link empty." };
  if (e.timing === "time" && e.time && !TIME.test(e.time)) return { field: "time", message: "Enter a time such as 18:30." };
  if (e.duration.trim() && (!/^[0-9]{1,3}$/.test(e.duration.trim()) || Number(e.duration) < 1 || Number(e.duration) > 240)) {
    return { field: "duration", message: "Enter whole minutes from 1 to 240." };
  }
  return null;
}

export function timedAnswersFromForm(editor: TimedEditor, form: TimedForm): Parsed<{ entries?: TimedEntry[]; choice?: ListChoice }> {
  const rules = TIMED_RULES[editor];
  if (form.entries.length > 40) return { ok: false, field: "entries", message: "Keep this to 40 entries or fewer." };
  const ids = new Set<string>();
  const entries: TimedEntry[] = [];
  for (const e of form.entries) {
    if (!UUID_RE.test(e.id) || ids.has(e.id)) return { ok: false, field: "entries", message: "Reload the page and try again." };
    ids.add(e.id);
    if (!rules.timings.includes(e.timing)) return { ok: false, field: entryField(e.id, "timing"), message: "Choose an option from the list." };
    const o: TimedEntry = { id: e.id, timing: e.timing };
    const limits = { ...rules.text, ...(rules.song ? SONG_FIELDS : {}), cue: 300 };
    for (const [field, max] of Object.entries(limits)) {
      if (String((e as Record<string, unknown>)[field] ?? "").trim().length > max) return { ok: false, field: entryField(e.id, field), message: `Keep this under ${max} characters.` };
    }
    const problem = timedEntryProblem(editor, e);
    if (problem) return { ok: false, field: entryField(e.id, problem.field), message: problem.message };
    for (const field of Object.keys({ ...rules.text, ...(rules.song ? SONG_FIELDS : {}) })) {
      const value = String((e as Record<string, unknown>)[field] ?? "").trim();
      if (value) o[field] = value;
    }
    if (e.timing === "time" && e.time) {
      o.time = e.time;
      if (e.next_day) o.next_day = true;
    }
    if (e.timing === "cue" && e.cue.trim()) o.cue = e.cue.trim();
    if (rules.duration && e.duration.trim()) o.duration = Number(e.duration.trim());
    entries.push(o);
  }
  const answers: { entries?: TimedEntry[]; choice?: ListChoice } = {};
  if (form.choice) {
    if (form.choice === "none" && entries.length > 0) return { ok: false, field: "choice", message: 'Remove the entries first, or keep them and choose "I\'ll list them".' };
    answers.choice = form.choice;
  }
  if (entries.length > 0) answers.entries = entries;
  return { ok: true, answers };
}

/** An entry is complete with a resolved timing, and for dedications a song. */
export function timedEntryResolved(editor: TimedEditor, e: TimedEntryForm): boolean {
  const timed = e.timing === "anytime" || (e.timing === "time" && Boolean(e.time)) || (e.timing === "cue" && Boolean(e.cue.trim()));
  return timed && (!TIMED_RULES[editor].requiresSong || Boolean(e.song_title.trim() && e.song_artist.trim()));
}

// Program details: the overall times and host besides the agenda.
export type ProgramForm = TimedForm & { start_time: string; start_next_day: boolean; end_time: string; end_next_day: boolean; host: string; host_pronunciation: string; notes: string };

export function programForm(a: TimedAnswers): ProgramForm {
  return {
    ...timedForm("program", a),
    start_time: String(a.start_time ?? ""), start_next_day: a.start_next_day === true, end_time: String(a.end_time ?? ""), end_next_day: a.end_next_day === true,
    host: String(a.host ?? ""), host_pronunciation: String(a.host_pronunciation ?? ""), notes: String(a.notes ?? ""),
  };
}

export function programAnswersFromForm(form: ProgramForm): Parsed<TimedAnswers> {
  const t = times(form);
  if (!t.ok) return t;
  const head: Record<string, unknown> = { ...t.answers };
  const problem = texts(form, { host: 200, host_pronunciation: 300, notes: 2000 }, head);
  if (problem) return { ok: false, ...problem };
  const list = timedAnswersFromForm("program", form);
  if (!list.ok) return list;
  return { ok: true, answers: { ...head, ...list.answers } };
}

/** Name suggestions for activities; anything else can be typed. */
export const ACTIVITY_SUGGESTIONS = [
  "Shoe game", "Bouquet toss", "Garter toss", "Centrepiece giveaway", "Anniversary dance", "Money dance", "Cultural tradition", "Photo booth", "Group photo",
];
