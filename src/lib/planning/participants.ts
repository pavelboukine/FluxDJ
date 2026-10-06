import { UUID_RE } from "@/lib/forms";
import { musicAnswersFromForm, type MusicAnswers, type MusicForm } from "./music";

/**
 * Participants, MC and speeches. The database (private.normalize_plan_*,
 * private.plan_moment_requirements and private.check_plan_song_links) is
 * authoritative; this mirrors it so a field can be pointed at before saving
 * and saved and current answers compare equal. Pronunciation guides are
 * plain text.
 */

/** Editors whose answers come in the views' "moments" map (general sections included). */
export const MOMENT_EDITORS = ["processional", "mc", "introductions", "speeches", "contacts", "preferences", "music_style"] as const;
export type MomentEditor = (typeof MOMENT_EDITORS)[number];
export function isMomentEditor(editor: string | null | undefined): editor is MomentEditor {
  return (MOMENT_EDITORS as readonly string[]).includes(editor ?? "");
}

/** Placeholder moments covered by another moment's editor, with the moment that covers them. */
export const INCLUDED_IN: Record<string, string> = { entrance_participants: "introductions" };

type Parsed<A> = { ok: true; answers: A } | { ok: false; field: string; message: string };
export const entryField = (id: string, field: string) => `entry:${id}:${field}`;

// ---------------------------------------------------------------------------
// People entries (Processional participants, reception introductions)
// ---------------------------------------------------------------------------

export const PERSON_LIMITS = { names: 300, role: 120, pronunciation: 300, wording: 500, notes: 500 } as const;
export type Person = { id: string; names: string; role?: string; pronunciation?: string; wording?: string; notes?: string; song_id?: string };
export type PersonForm = { id: string; names: string; role: string; pronunciation: string; wording: string; notes: string; song_id: string };

export function emptyPerson(id: string): PersonForm {
  return { id, names: "", role: "", pronunciation: "", wording: "", notes: "", song_id: "" };
}
export function personForm(p: Person): PersonForm {
  return { ...emptyPerson(p.id), ...p };
}

function parsePeople(people: PersonForm[], opts: { max: number; wording: boolean }): Parsed<Person[]> {
  if (people.length > opts.max) return { ok: false, field: "entries", message: `Keep this to ${opts.max} entries or fewer.` };
  const ids = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    if (!UUID_RE.test(p.id) || ids.has(p.id)) return { ok: false, field: "entries", message: "Reload the page and try again." };
    ids.add(p.id);
    const o: Person = { id: p.id, names: "" };
    for (const field of ["names", "role", "pronunciation", "wording", "notes"] as const) {
      if (field === "wording" && !opts.wording) continue;
      const value = p[field].trim();
      if (value.length > PERSON_LIMITS[field]) return { ok: false, field: entryField(p.id, field), message: `Keep this under ${PERSON_LIMITS[field]} characters.` };
      if (value) o[field] = value;
    }
    if (!o.names) return { ok: false, field: entryField(p.id, "names"), message: "Enter the name or names." };
    if (p.song_id) {
      // Linked songs may live in another moment (Couple entrance, Entrance music): the server checks them there.
      if (!UUID_RE.test(p.song_id)) return { ok: false, field: entryField(p.id, "song_id"), message: "Reload the page and try again." };
      o.song_id = p.song_id;
    }
    out.push(o);
  }
  return { ok: true, answers: out };
}

// Processional: its songs plus who walks in.
export type ProcessionalAnswers = MusicAnswers & { participants?: Person[]; participants_choice?: "discuss" };
export type ProcessionalForm = MusicForm & { participants: PersonForm[]; participants_choice: "" | "discuss" };

export function processionalForm(a: ProcessionalAnswers): ProcessionalForm {
  return {
    songs: (a.songs ?? []).map((s) => ({ id: s.id, title: s.title, artist: s.artist, version: s.version ?? "", link: s.link ?? "", notes: s.notes ?? "", cue: s.cue ?? "" })),
    choice: a.choice ?? "",
    participants: (a.participants ?? []).map(personForm),
    participants_choice: a.participants_choice ?? "",
  };
}

export function processionalAnswersFromForm(form: ProcessionalForm): Parsed<ProcessionalAnswers> {
  const music = musicAnswersFromForm("moment_songs", { songs: form.songs, choice: form.choice });
  if (!music.ok) return music;
  const people = parsePeople(form.participants, { max: 30, wording: false });
  if (!people.ok) return people;
  const answers: ProcessionalAnswers = { ...music.answers };
  if (people.answers.length > 0) {
    if (answers.choice === "not_applicable") {
      return { ok: false, field: "choice", message: 'Remove the people walking in first, or keep them and choose "I\'ll list the songs".' };
    }
    answers.participants = people.answers;
  }
  if (form.participants_choice === "discuss") answers.participants_choice = "discuss";
  return { ok: true, answers };
}

// Introductions: {entries, choice}.
export type ListChoice = "none" | "discuss";
export type IntroductionsAnswers = { entries?: Person[]; choice?: ListChoice };
export type IntroductionsForm = { entries: PersonForm[]; choice: ListChoice | "" };

export function introductionsForm(a: IntroductionsAnswers): IntroductionsForm {
  return { entries: (a.entries ?? []).map(personForm), choice: a.choice ?? "" };
}

export function introductionsAnswersFromForm(form: IntroductionsForm): Parsed<IntroductionsAnswers> {
  const people = parsePeople(form.entries, { max: 40, wording: true });
  if (!people.ok) return people;
  return withChoice(people.answers, form.choice);
}

function withChoice<E>(entries: E[], choice: ListChoice | ""): Parsed<{ entries?: E[]; choice?: ListChoice }> {
  const answers: { entries?: E[]; choice?: ListChoice } = {};
  if (choice) {
    if (choice === "none" && entries.length > 0) return { ok: false, field: "choice", message: 'Remove the entries first, or keep them and choose "I\'ll list them".' };
    answers.choice = choice;
  }
  if (entries.length > 0) answers.entries = entries;
  return { ok: true, answers };
}

// ---------------------------------------------------------------------------
// Speeches and toasts
// ---------------------------------------------------------------------------

export const SPEECH_LIMITS = { speaker: 200, role: 120, pronunciation: 300, cue: 300, av_notes: 500, notes: 500 } as const;
export type Timing = "time" | "cue" | "undecided";
export type Speech = {
  id: string; speaker: string; role?: string; pronunciation?: string; timing: Timing; time?: string; next_day?: true; cue?: string;
  duration?: number; av_notes?: string; notes?: string;
};
export type SpeechForm = {
  id: string; speaker: string; role: string; pronunciation: string; timing: Timing; time: string; next_day: boolean; cue: string;
  duration: string; av_notes: string; notes: string;
};
export type SpeechesAnswers = { entries?: Speech[]; choice?: ListChoice };
export type SpeechesForm = { entries: SpeechForm[]; choice: ListChoice | "" };

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function emptySpeech(id: string): SpeechForm {
  return { id, speaker: "", role: "", pronunciation: "", timing: "undecided", time: "", next_day: false, cue: "", duration: "", av_notes: "", notes: "" };
}
export function speechForm(s: Speech): SpeechForm {
  return {
    ...emptySpeech(s.id), ...s, time: s.time ?? "", cue: s.cue ?? "", next_day: s.next_day === true,
    duration: s.duration === undefined ? "" : String(s.duration), role: s.role ?? "", pronunciation: s.pronunciation ?? "",
    av_notes: s.av_notes ?? "", notes: s.notes ?? "",
  };
}
export function speechesForm(a: SpeechesAnswers): SpeechesForm {
  return { entries: (a.entries ?? []).map(speechForm), choice: a.choice ?? "" };
}

export function speechesAnswersFromForm(form: SpeechesForm): Parsed<SpeechesAnswers> {
  if (form.entries.length > 30) return { ok: false, field: "entries", message: "Keep this to 30 entries or fewer." };
  const ids = new Set<string>();
  const out: Speech[] = [];
  for (const s of form.entries) {
    if (!UUID_RE.test(s.id) || ids.has(s.id)) return { ok: false, field: "entries", message: "Reload the page and try again." };
    ids.add(s.id);
    const o: Speech = { id: s.id, speaker: "", timing: s.timing };
    for (const field of ["speaker", "role", "pronunciation", "av_notes", "notes"] as const) {
      const value = s[field].trim();
      if (value.length > SPEECH_LIMITS[field]) return { ok: false, field: entryField(s.id, field), message: `Keep this under ${SPEECH_LIMITS[field]} characters.` };
      if (value) o[field] = value;
    }
    if (!o.speaker) return { ok: false, field: entryField(s.id, "speaker"), message: "Enter the speaker's name." };
    if (!["time", "cue", "undecided"].includes(s.timing)) return { ok: false, field: entryField(s.id, "timing"), message: "Choose an option from the list." };
    if (s.timing === "time" && s.time) {
      if (!TIME.test(s.time)) return { ok: false, field: entryField(s.id, "time"), message: "Enter a time such as 18:30." };
      o.time = s.time;
      if (s.next_day) o.next_day = true;
    }
    if (s.timing === "cue") {
      const cue = s.cue.trim();
      if (cue.length > SPEECH_LIMITS.cue) return { ok: false, field: entryField(s.id, "cue"), message: `Keep this under ${SPEECH_LIMITS.cue} characters.` };
      if (cue) o.cue = cue;
    }
    const duration = s.duration.trim();
    if (duration) {
      if (!/^[0-9]{1,3}$/.test(duration) || Number(duration) < 1 || Number(duration) > 240) {
        return { ok: false, field: entryField(s.id, "duration"), message: "Enter whole minutes from 1 to 240." };
      }
      o.duration = Number(duration);
    }
    out.push(o);
  }
  return withChoice(out, form.choice);
}

/** A speech counts once it has a speaker and a resolved timing: a time, or a cue. */
export function speechResolved(s: Speech): boolean {
  return (s.timing === "time" && Boolean(s.time)) || (s.timing === "cue" && Boolean(s.cue));
}

// ---------------------------------------------------------------------------
// MC
// ---------------------------------------------------------------------------

export type McChoice = "dj" | "other" | "none" | "discuss";
export type McAnswers = { mc?: McChoice; name?: string; pronunciation?: string; contact?: string; notes?: string };
export type McForm = { mc: McChoice | ""; name: string; pronunciation: string; contact: string; notes: string };
export const MC_LIMITS = { name: 200, pronunciation: 300, contact: 300, notes: 1000 } as const;

export function mcForm(a: McAnswers): McForm {
  return { mc: a.mc ?? "", name: a.name ?? "", pronunciation: a.pronunciation ?? "", contact: a.contact ?? "", notes: a.notes ?? "" };
}

/** Someone else's details are kept only while someone else is the MC (the form keeps them meanwhile). */
export function mcAnswersFromForm(form: McForm): Parsed<McAnswers> {
  const answers: McAnswers = {};
  if (form.mc) {
    if (!["dj", "other", "none", "discuss"].includes(form.mc)) return { ok: false, field: "mc", message: "Choose an option from the list." };
    answers.mc = form.mc;
  }
  for (const field of ["name", "pronunciation", "contact", "notes"] as const) {
    const value = form[field].trim();
    if (value.length > MC_LIMITS[field]) return { ok: false, field, message: `Keep this under ${MC_LIMITS[field].toLocaleString("en-CA")} characters.` };
    if (value && (field === "notes" || form.mc === "other")) answers[field] = value;
  }
  return { ok: true, answers };
}

// ---------------------------------------------------------------------------
// Song links
// ---------------------------------------------------------------------------

/** Song id -> names of the entries linked to it. */
export function linksBySong(entries: { names: string; song_id?: string }[]): Map<string, string[]> {
  const links = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.song_id) continue;
    links.set(e.song_id, [...(links.get(e.song_id) ?? []), e.names.trim() || "Unnamed entry"]);
  }
  return links;
}

/** How a linked song reads next to its entry: from the song itself, never copied. */
export function songLabel(song: { title: string; artist: string; cue?: string } | undefined): string | null {
  if (!song) return null;
  return `${song.cue ? `${song.cue}: ` : ""}${song.title} by ${song.artist}`;
}
