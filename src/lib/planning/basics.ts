/**
 * Event basics: the one planning editor available now. The database
 * (private.normalize_plan_basics) is authoritative; this mirrors it so the
 * form can point at a field before saving, and so "what was saved" compares
 * equal to what the server stores.
 *
 * Planning-only fields. Names, the date and the venue come from the event
 * details staff entered, and frozen proposal answers come from the signed
 * contract; neither is asked again here.
 */

export type BasicsAnswers = {
  guest_count?: number;
  start_time?: string;
  end_time?: string;
  venue_details?: string;
  venue_room?: string;
  access_notes?: string;
  access_notes_none?: true;
  announcement_language?: AnnouncementLanguage;
};

export const ANNOUNCEMENT_LANGUAGES = [
  ["french", "French"],
  ["english", "English"],
  ["bilingual", "Bilingual (French and English)"],
  ["other", "Other"],
] as const;
export type AnnouncementLanguage = (typeof ANNOUNCEMENT_LANGUAGES)[number][0];

/** What the form holds: raw text, so nothing typed is ever lost. */
export type BasicsForm = {
  guest_count: string;
  start_time: string;
  end_time: string;
  venue_details: string;
  venue_room: string;
  access_notes: string;
  access_notes_none: boolean;
  announcement_language: string;
};

export type BasicsField = keyof BasicsForm;

export function formFromAnswers(a: BasicsAnswers): BasicsForm {
  return {
    guest_count: a.guest_count === undefined ? "" : String(a.guest_count),
    start_time: a.start_time ?? "",
    end_time: a.end_time ?? "",
    venue_details: a.venue_details ?? "",
    venue_room: a.venue_room ?? "",
    access_notes: a.access_notes ?? "",
    access_notes_none: a.access_notes_none === true,
    announcement_language: a.announcement_language ?? "",
  };
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const LIMITS = { venue_details: 500, venue_room: 200, access_notes: 2000 } as const;

/** Validates and normalizes the form like the database does. */
export function answersFromForm(f: BasicsForm): { ok: true; answers: BasicsAnswers } | { ok: false; field: BasicsField; message: string } {
  const answers: BasicsAnswers = {};
  const guests = f.guest_count.trim();
  if (guests !== "") {
    if (!/^[0-9]{1,4}$/.test(guests) || Number(guests) < 1 || Number(guests) > 5000) {
      return { ok: false, field: "guest_count", message: "Enter a guest count between 1 and 5,000." };
    }
    answers.guest_count = Number(guests);
  }
  for (const field of ["start_time", "end_time"] as const) {
    const value = f[field].trim();
    if (value === "") continue;
    if (!TIME.test(value)) return { ok: false, field, message: "Enter a time such as 18:30." };
    answers[field] = value;
  }
  if (answers.start_time && answers.start_time === answers.end_time) {
    return { ok: false, field: "end_time", message: "The end time must differ from the start time." };
  }
  for (const field of ["venue_details", "venue_room", "access_notes"] as const) {
    const value = f[field].trim();
    if (value.length > LIMITS[field]) {
      return { ok: false, field, message: `Keep this under ${LIMITS[field].toLocaleString("en-CA")} characters.` };
    }
    if (value !== "") answers[field] = value;
  }
  if (f.access_notes_none) {
    if (answers.access_notes) {
      return { ok: false, field: "access_notes", message: 'Describe the access details or choose "No special instructions", not both.' };
    }
    answers.access_notes_none = true;
  }
  if (f.announcement_language !== "") {
    if (!ANNOUNCEMENT_LANGUAGES.some(([value]) => value === f.announcement_language)) {
      return { ok: false, field: "announcement_language", message: "Choose a language from the list." };
    }
    answers.announcement_language = f.announcement_language as AnnouncementLanguage;
  }
  return { ok: true, answers };
}

/** Stable JSON for comparing saved and current answers (key order independent). */
export function answersKey(a: BasicsAnswers): string {
  return JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))));
}

/** An end earlier than the start is the next day (events often end after midnight). */
export function endsAfterMidnight(start: string | undefined, end: string | undefined): boolean {
  return Boolean(start && end && TIME.test(start) && TIME.test(end) && end < start);
}

export const BASICS_REQUIREMENT_LABELS: Record<string, string> = {
  guest_count: "Guest count",
  start_time: "Start time",
  end_time: "End time",
  venue: "Venue",
  access: "DJ access and load-in",
};
