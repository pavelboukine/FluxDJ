import { UUID_RE } from "@/lib/forms";
import { entryField } from "./participants";

/**
 * Contacts and vendors, DJ expectations and the Party's music preferences.
 * The database (private.normalize_plan_contacts, _preferences, _music_style
 * and the requirement functions) is authoritative; this mirrors it so a field
 * can be pointed at before saving and saved and current answers compare
 * equal. Planning contacts never change the event's clients.
 */

type Parsed<A> = { ok: true; answers: A } | { ok: false; field: string; message: string };

/** 7 to 20 digits, with optional +, spaces, dots, dashes or brackets. Mirrors private.is_phone. */
export function isPhone(value: string): boolean {
  return /^\+?[0-9 ().-]{7,30}$/.test(value) && value.replace(/[^0-9]/g, "").length >= 7 && value.replace(/[^0-9]/g, "").length <= 20;
}
/** Mirrors private.is_email: a plausible address, never verified or contacted. */
export function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}
const PHONE_MESSAGE = "Enter a phone number with 7 to 20 digits, such as 514 555-0100.";
const EMAIL_MESSAGE = "Enter an email address such as name@example.com.";

// ---------------------------------------------------------------------------
// Contacts and vendors
// ---------------------------------------------------------------------------

export const VENDOR_ROLES = [
  ["planner", "Planner or coordinator"],
  ["venue", "Venue"],
  ["photographer", "Photographer"],
  ["videographer", "Videographer"],
  ["caterer", "Caterer"],
  ["musician", "Live musician"],
  ["other", "Other"],
] as const;
export type VendorRole = (typeof VENDOR_ROLES)[number][0];
export const roleLabel = (role: string) => VENDOR_ROLES.find(([v]) => v === role)?.[1] ?? "Other";

export type Vendor = { id: string; role: VendorRole; name?: string; business?: string; phone?: string; email?: string; notes?: string };
export type VendorForm = { id: string; role: VendorRole | ""; name: string; business: string; phone: string; email: string; notes: string };
export const VENDOR_LIMITS = { name: 200, business: 200, phone: 30, email: 254, notes: 500 } as const;

export type DayOfSource = "event_contact" | "other" | "undecided";
export type ContactsAnswers = {
  day_of_source?: DayOfSource; day_of_client_id?: string; day_of_name?: string; day_of_phone?: string; day_of_role?: string;
  vendors?: Vendor[]; vendors_choice?: "none";
};
export type ContactsForm = {
  day_of_source: DayOfSource | ""; day_of_client_id: string; day_of_name: string; day_of_phone: string; day_of_role: string;
  vendors: VendorForm[]; vendors_choice: "" | "none";
};
/** An event contact planning may show and point at (client-safe: name and phone). */
export type EventContact = { id: string; name: string; phone: string | null; primary: boolean };

export function emptyVendor(id: string): VendorForm {
  return { id, role: "", name: "", business: "", phone: "", email: "", notes: "" };
}

export function contactsForm(a: ContactsAnswers): ContactsForm {
  return {
    day_of_source: a.day_of_source ?? "", day_of_client_id: a.day_of_client_id ?? "", day_of_name: a.day_of_name ?? "",
    day_of_phone: a.day_of_phone ?? "", day_of_role: a.day_of_role ?? "",
    vendors: (a.vendors ?? []).map((v) => ({ ...emptyVendor(v.id), ...v })),
    vendors_choice: a.vendors_choice ?? "",
  };
}

/** What a vendor entry still needs before it can be added, or null. */
export function vendorProblem(v: VendorForm): { field: string; message: string } | null {
  if (!VENDOR_ROLES.some(([r]) => r === v.role)) return { field: "role", message: "Choose a role." };
  if (!v.name.trim() && !v.business.trim()) return { field: "name", message: "Enter a person's name or a business name." };
  if (v.phone.trim() && !isPhone(v.phone.trim())) return { field: "phone", message: PHONE_MESSAGE };
  if (v.email.trim() && !isEmail(v.email.trim())) return { field: "email", message: EMAIL_MESSAGE };
  return null;
}

export function contactsAnswersFromForm(form: ContactsForm): Parsed<ContactsAnswers> {
  const a: ContactsAnswers = {};
  const src = form.day_of_source;
  if (src) a.day_of_source = src;
  if (src === "event_contact" && form.day_of_client_id) {
    if (!UUID_RE.test(form.day_of_client_id)) return { ok: false, field: "day_of_client_id", message: "Reload the page and try again." };
    a.day_of_client_id = form.day_of_client_id;
  }
  const phone = form.day_of_phone.trim();
  if (phone && (src === "event_contact" || src === "other")) {
    if (!isPhone(phone)) return { ok: false, field: "day_of_phone", message: PHONE_MESSAGE };
    a.day_of_phone = phone;
  }
  for (const [field, max] of [["day_of_name", 200], ["day_of_role", 120]] as const) {
    const value = form[field].trim();
    if (value.length > max) return { ok: false, field, message: `Keep this under ${max} characters.` };
    if (value && src === "other") a[field] = value;
  }
  if (form.vendors.length > 30) return { ok: false, field: "vendors", message: "Keep this to 30 entries or fewer." };
  const ids = new Set<string>();
  const vendors: Vendor[] = [];
  for (const v of form.vendors) {
    if (!UUID_RE.test(v.id) || ids.has(v.id)) return { ok: false, field: "vendors", message: "Reload the page and try again." };
    ids.add(v.id);
    for (const field of ["name", "business", "phone", "email", "notes"] as const) {
      if (v[field].trim().length > VENDOR_LIMITS[field]) return { ok: false, field: entryField(v.id, field), message: `Keep this under ${VENDOR_LIMITS[field]} characters.` };
    }
    const problem = vendorProblem(v);
    if (problem) return { ok: false, field: entryField(v.id, problem.field), message: problem.message };
    const o: Vendor = { id: v.id, role: v.role as VendorRole };
    for (const field of ["name", "business", "phone", "email", "notes"] as const) if (v[field].trim()) o[field] = v[field].trim();
    vendors.push(o);
  }
  if (form.vendors_choice === "none") {
    if (vendors.length > 0) return { ok: false, field: "vendors_choice", message: 'Remove the vendors first, or keep them and choose "I\'ll list them".' };
    a.vendors_choice = "none";
  }
  if (vendors.length > 0) a.vendors = vendors;
  return { ok: true, answers: a };
}

// ---------------------------------------------------------------------------
// DJ expectations and overall preferences (language comes from Event basics)
// ---------------------------------------------------------------------------

export const INTERACTION = [
  ["music_mostly", "Mostly music, few words"],
  ["occasional", "Occasional announcements"],
  ["interactive", "Interactive: get the crowd going"],
  ["discuss", "Not sure yet, discuss with the DJ"],
] as const;
export const LYRICS = [
  ["clean", "Clean versions only"],
  ["explicit_ok", "Explicit lyrics are fine"],
  ["discuss", "Not sure yet, discuss with the DJ"],
] as const;
export const REQUESTS = [
  ["welcome", "Guests may request songs (never anything on Do not play)"],
  ["not_welcome", "No guest requests"],
  ["discuss", "Not sure yet, discuss with the DJ"],
] as const;
export type PreferencesAnswers = { atmosphere?: string; interaction?: string; lyrics?: string; requests?: string; notes?: string };
export type PreferencesForm = { atmosphere: string; interaction: string; lyrics: string; requests: string; notes: string };

export function preferencesForm(a: PreferencesAnswers): PreferencesForm {
  return { atmosphere: a.atmosphere ?? "", interaction: a.interaction ?? "", lyrics: a.lyrics ?? "", requests: a.requests ?? "", notes: a.notes ?? "" };
}

function choicesAndText<F extends Record<string, string>>(form: F, choices: Record<string, readonly (readonly [string, string])[]>, text: Record<string, number>): Parsed<Record<string, string>> {
  const a: Record<string, string> = {};
  for (const [field, raw] of Object.entries(form)) {
    const value = raw.trim();
    if (!value) continue;
    if (choices[field]) {
      if (!choices[field].some(([v]) => v === value)) return { ok: false, field, message: "Choose an option from the list." };
    } else if (value.length > text[field]) {
      return { ok: false, field, message: `Keep this under ${text[field].toLocaleString("en-CA")} characters.` };
    }
    a[field] = value;
  }
  return { ok: true, answers: a };
}

export function preferencesAnswersFromForm(form: PreferencesForm): Parsed<PreferencesAnswers> {
  return choicesAndText(form, { interaction: INTERACTION, lyrics: LYRICS, requests: REQUESTS }, { atmosphere: 1000, notes: 1000 });
}

// ---------------------------------------------------------------------------
// Party music preferences (specific songs stay in Must play / Do not play)
// ---------------------------------------------------------------------------

export const GENRES = [
  ["pop", "Pop"],
  ["dance", "Dance"],
  ["hiphop_rnb", "Hip-hop and R&B"],
  ["rock", "Rock"],
  ["disco_funk", "Disco and funk"],
  ["country", "Country"],
  ["latin", "Latin"],
  ["house_electronic", "House and electronic"],
  ["throwbacks", "Throwbacks"],
] as const;
export const SLOW_SONGS = [
  ["dj_choice", "DJ's choice"],
  ["none", "No slow songs"],
  ["a_few", "A few"],
  ["discuss", "Not sure yet, discuss with the DJ"],
] as const;
export type MusicStyleAnswers = { genres?: string[]; other_style?: string; style_choice?: "dj_choice"; favorite_artists?: string; dance_floor?: string; slow_songs?: string };
export type MusicStyleForm = { genres: string[]; other_style: string; style_choice: "" | "dj_choice"; favorite_artists: string; dance_floor: string; slow_songs: string };

export function musicStyleForm(a: MusicStyleAnswers): MusicStyleForm {
  return {
    genres: a.genres ?? [], other_style: a.other_style ?? "", style_choice: a.style_choice ?? "",
    favorite_artists: a.favorite_artists ?? "", dance_floor: a.dance_floor ?? "", slow_songs: a.slow_songs ?? "",
  };
}

export function musicStyleAnswersFromForm(form: MusicStyleForm): Parsed<MusicStyleAnswers> {
  const { genres, ...rest } = form;
  const r = choicesAndText(rest, { style_choice: [["dj_choice", ""]], slow_songs: SLOW_SONGS }, { other_style: 300, favorite_artists: 500, dance_floor: 1000 });
  if (!r.ok) return r;
  if (genres.some((g) => !GENRES.some(([v]) => v === g))) return { ok: false, field: "genres", message: "Choose styles from the list." };
  // Kept in the list's own order, once each.
  const ordered = GENRES.map(([v]) => v).filter((v) => genres.includes(v));
  const answers: MusicStyleAnswers = { ...r.answers } as MusicStyleAnswers;
  if (answers.style_choice === "dj_choice" && (ordered.length > 0 || answers.other_style)) {
    return { ok: false, field: "style_choice", message: 'Clear the styles first, or keep them and choose "I\'ll pick styles".' };
  }
  if (ordered.length > 0) answers.genres = ordered;
  return { ok: true, answers };
}
