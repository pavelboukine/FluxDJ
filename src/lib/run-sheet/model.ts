import { ANNOUNCEMENT_LANGUAGES, BASICS_REQUIREMENT_LABELS, endsAfterMidnight, type BasicsAnswers } from "@/lib/planning/basics";
import { GENRES, INTERACTION, LYRICS, REQUESTS, SLOW_SONGS, roleLabel, type ContactsAnswers, type EventContact, type MusicStyleAnswers, type PreferencesAnswers } from "@/lib/planning/contacts";
import { isMusicEditor, matchKey, type MusicAnswers, type MusicEditor, type Song } from "@/lib/planning/music";
import type { IntroductionsAnswers, McAnswers, Person, ProcessionalAnswers, Speech, SpeechesAnswers } from "@/lib/planning/participants";
import { nextDayLabel, REQUIREMENT_NOTES, STAGE_REQUIREMENT_LABELS } from "@/lib/planning/stages";
import type { ArrivalAnswers, TimedAnswers, TimedEntry } from "@/lib/planning/timed";
import { formatInstant } from "@/lib/planning/cutoff";
import { formatEventDate, formatImportedAnswer, type StaffPlanningView } from "@/lib/planning/view";

/**
 * The DJ run sheet: one typed, read-only projection of the latest saved plan,
 * shared by the live staff view and the PDF so both always say the same
 * thing.
 *
 * Input is a single staff_planning_view result (one database snapshot:
 * answers, revisions and song links all belong together) plus the event and
 * business rows. Nothing is written, nothing comes from browser form state,
 * and frozen proposal answers come only from the view's import, never the
 * current catalog. Hidden stages and moments are left out; explicit choices
 * ("Not applicable", "DJ's choice", "None") stay distinct from unanswered
 * ones. Stages keep the staff-configured order; times never reorder them and
 * contextual cues are never presented as exact times.
 *
 * Deliberately excluded: internal event notes, payments, signing evidence,
 * tokens, client emails, audit history and staff identities.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** When something happens. "sequence": no timing of its own; it follows the stage order. */
export type When =
  | { kind: "time"; time: string; nextDay: boolean }
  | { kind: "cue"; cue: string }
  | { kind: "anytime" }
  | { kind: "undecided" }
  | { kind: "missing" }
  | { kind: "sequence" };

export type PersonLine = { names: string; pronunciation?: string; role?: string; wording?: string };
export type SongLine = { title: string; artist: string; version?: string; cue?: string; notes?: string };
/** An explicit answer instead of content. */
export type Status = { tone: "choice" | "open" | "none"; text: string };

/** One line of the gig overview: when, what and who, which songs, and what to do. */
export type Row = {
  id: string;
  when: When;
  title: string;
  people: PersonLine[];
  songs: SongLine[];
  notes: string[];
  status: Status | null;
  /** Something still missing for this entry (shown, never hidden). */
  warning?: string;
};

export type Pair = { label: string; value: string };

export type StageSheet = {
  id: string;
  key: string;
  label: string;
  times: { label: string; when: When }[];
  location: string | null;
  /** Instructions for the DJ: always shown with the stage. */
  instructions: Pair[];
  /** Further saved details (detailed section). */
  details: Pair[];
  rows: Row[];
};

export type MusicListKind = "background" | "requests" | "exclusions";
export type MusicList = { id: string; key: string; label: string; stageLabel: string; kind: MusicListKind; status: Status | null; songs: SongLine[] };

export type Warning = { kind: "timing" | "conflict" | "unresolved" | "schedule"; text: string };

export type RunSheet = {
  business: { name: string; color: string };
  event: {
    title: string; typeLabel: string; date: string; dateLabel: string; timezone: string;
    venueName: string | null; venueAddress: string | null; archived: boolean; booked: boolean;
  };
  /** Database time of the snapshot ("Latest saved plan as of"). */
  asOf: string;
  planReady: boolean;
  /** Client editing state, for context only: staff can still edit; this is never "final". */
  editing: string | null;
  times: Pair[];
  essentials: (Pair & { phone?: string; warn?: boolean })[];
  preferences: Pair[];
  warnings: Warning[];
  stages: StageSheet[];
  vendors: { state: "listed" | "none" | "unanswered" | "hidden"; entries: { role: string; name: string; phone?: string; email?: string; notes?: string }[] };
  musicLists: MusicList[];
  imported: { capturedAt: string; answers: Pair[] } | null;
};

export type RunSheetInput = {
  business: { display_name: string; brand_colors: Record<string, unknown> };
  event: {
    title: string; event_type: string; event_date: string; timezone: string; venue_name: string | null; venue_address: string | null;
    archived_at: string | null; booking_confirmed_at: string | null; lifecycle_status: string;
  };
  view: StaffPlanningView;
  eventTypeLabel: string;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Answers = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const labelOf = (options: readonly (readonly [string, string])[], value: unknown) => options.find(([v]) => v === value)?.[1];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function at(a: Answers, prefix: string): When | null {
  const t = a[`${prefix}_time`];
  return typeof t === "string" && TIME.test(t) ? { kind: "time", time: t, nextDay: a[`${prefix}_next_day`] === true } : null;
}

/** How a When reads. Next-day times name the day; cues are never shown as clock times. */
export function whenText(w: When, eventDate: string): string {
  switch (w.kind) {
    case "time":
      return w.nextDay ? `${w.time} (next day, ${nextDayLabel(eventDate)})` : w.time;
    case "cue":
      return `Cue: ${w.cue}`;
    case "anytime":
      return "Any time during the party";
    case "undecided":
      return "Time not decided yet";
    case "missing":
      return "Not set";
    case "sequence":
      return "In order";
  }
}

/** Minutes from the start of the event day, for comparisons only (never for ordering stages). */
function minutesOf(w: When | null | undefined): number | null {
  if (!w || w.kind !== "time") return null;
  return Number(w.time.slice(0, 2)) * 60 + Number(w.time.slice(3)) + (w.nextDay ? 1440 : 0);
}

function song(s: Partial<Song> | undefined): SongLine | null {
  const title = str(s?.title);
  const artist = str(s?.artist);
  if (!title || !artist) return null;
  return { title, artist, version: str(s?.version), cue: str(s?.cue), notes: str(s?.notes) };
}
const songs = (list: unknown): SongLine[] => (Array.isArray(list) ? list.map((s) => song(s as Song)).filter((s): s is SongLine => s !== null) : []);

function person(p: Partial<Person>): PersonLine | null {
  const names = str(p.names);
  return names ? { names, pronunciation: str(p.pronunciation), role: str(p.role), wording: str(p.wording) } : null;
}

export function songText(s: SongLine): string {
  return `${s.title} by ${s.artist}${s.version ? ` (${s.version})` : ""}`;
}

const MOMENT_CHOICE: Record<string, Status> = {
  dj_choice: { tone: "choice", text: "DJ's choice" },
  not_applicable: { tone: "none", text: "Not applicable: this moment won't happen" },
  discuss: { tone: "open", text: "Discuss with DJ (still open)" },
};
const UNANSWERED: Status = { tone: "open", text: "Not answered yet" };

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

export function buildRunSheet(input: RunSheetInput): RunSheet {
  const { event, view } = input;
  const date = event.event_date;
  const venueText = [event.venue_name, event.venue_address].filter(Boolean).join(", ") || null;
  const base: RunSheet = {
    business: { name: input.business.display_name, color: typeof input.business.brand_colors.primary === "string" ? input.business.brand_colors.primary : "#111827" },
    event: {
      title: event.title, typeLabel: input.eventTypeLabel, date, dateLabel: formatEventDate(date), timezone: event.timezone,
      venueName: event.venue_name, venueAddress: event.venue_address, archived: Boolean(event.archived_at),
      booked: Boolean(event.booking_confirmed_at) && (event.lifecycle_status === "booked" || event.lifecycle_status === "completed"),
    },
    asOf: view.plan === null ? new Date().toISOString() : (view.editing?.now ?? new Date().toISOString()),
    planReady: view.plan !== null,
    editing: null,
    times: [],
    essentials: [],
    preferences: [],
    warnings: [],
    stages: [],
    vendors: { state: "hidden", entries: [] },
    musicLists: [],
    imported: null,
  };
  if (view.plan === null) return base;

  const general = view.structure.general.filter((g) => !g.disabled);
  const stages = view.structure.stages.filter((s) => !s.disabled).map((s) => ({ ...s, moments: s.moments.filter((m) => !m.disabled) }));
  const labelById = new Map<string, string>();
  for (const g of general) labelById.set(g.id, g.label);
  for (const s of stages) {
    labelById.set(s.id, s.label);
    for (const m of s.moments) labelById.set(m.id, `${s.label} · ${m.label}`);
  }
  const answersOf = (id: string): Answers => (view.moments[id]?.answers ?? view.music[id]?.answers ?? {}) as Answers;
  const moment = (editor: string) => stages.flatMap((s) => s.moments).find((m) => m.editor === editor);
  const basics = view.basics.answers as BasicsAnswers;
  const stageAnswers = (editor: string): Answers | null => {
    const s = stages.find((x) => x.editor === editor);
    return s ? ((view.stage_details[s.id]?.answers ?? {}) as Answers) : null;
  };
  const ceremony = stageAnswers("stage_ceremony");

  const location = (a: Answers): string | null => {
    const where = a.location_source === "event_venue" ? (venueText ? `Event venue: ${venueText}` : "Event venue (not entered yet)")
      : a.location_source === "ceremony" ? (ceremony ? `Same as the ceremony: ${location(ceremony) ?? "not set there yet"}` : "Same as the ceremony (no visible Ceremony)")
      : str(a.location_other) ?? null;
    const area = str(a.location_area);
    return where && area ? `${where} · ${area}` : (where ?? (area ? `Area: ${area}` : null));
  };

  // -- Times: DJ service (Event basics) versus the stages' own times -------
  const serviceStart: When | null = basics.start_time ? { kind: "time", time: basics.start_time, nextDay: false } : null;
  const serviceEnd: When | null = basics.end_time ? { kind: "time", time: basics.end_time, nextDay: endsAfterMidnight(basics.start_time, basics.end_time) } : null;
  base.times.push({
    label: "DJ service (Event basics)",
    value: serviceStart || serviceEnd
      ? `${serviceStart ? whenText(serviceStart, date) : "Start not set"} – ${serviceEnd ? whenText(serviceEnd, date) : "end not set"}`
      : "Not set yet",
  });
  if (typeof basics.guest_count === "number") base.times.push({ label: "Guests", value: String(basics.guest_count) });

  // -- Stages ----------------------------------------------------------------
  const introductions = moment("introductions");
  const introEntries = ((introductions ? (answersOf(introductions.id) as IntroductionsAnswers).entries : undefined) ?? []).filter((e) => str(e.names));
  const processional = moment("processional");
  const processionalAnswers = (processional ? answersOf(processional.id) : {}) as ProcessionalAnswers;
  const procPeople = (processionalAnswers.participants ?? []).filter((p) => str(p.names));
  const coupleEntrance = stages.flatMap((s) => s.moments).find((m) => m.key === "couple_entrance");
  const coupleSongIds = new Set(((coupleEntrance ? (answersOf(coupleEntrance.id) as MusicAnswers).songs : undefined) ?? []).map((s) => s.id));
  const entranceMusic = stages.flatMap((s) => s.moments).find((m) => m.key === "entrance_music");
  const entranceSongs = new Map(((entranceMusic ? (answersOf(entranceMusic.id) as MusicAnswers).songs : undefined) ?? []).map((s) => [s.id, s]));

  for (const s of stages) {
    const a = (view.stage_details[s.id]?.answers ?? {}) as Answers;
    const sheet: StageSheet = { id: s.id, key: s.key, label: s.label, times: [], location: null, instructions: [], details: [], rows: [] };
    const time = (label: string, prefix: string, needed: boolean) => {
      const w = at(a, prefix);
      if (w) sheet.times.push({ label, when: w });
      else if (needed) sheet.times.push({ label, when: { kind: "missing" } });
    };
    const detail = (label: string, value: string | undefined | null) => {
      if (value) sheet.details.push({ label, value });
    };
    switch (s.editor) {
      case "stage_ceremony":
        time("Guest arrival", "guest_arrival", false);
        time("Start", "start", true);
        time("End", "end", false);
        sheet.location = location(a) ?? "Location not set";
        if (str(a.officiant_name) || str(a.officiant_contact)) detail("Officiant", [str(a.officiant_name), str(a.officiant_contact)].filter(Boolean).join(" · "));
        detail("Microphones", a.microphones === "needed" ? "Needed" : a.microphones === "not_needed" ? "Not needed" : a.microphones === "discuss" ? "Discuss with DJ (still open)" : "Not answered yet");
        detail("Who will speak", str(a.microphone_notes));
        if (str(a.instructions)) sheet.instructions.push({ label: "Instructions", value: str(a.instructions)! });
        break;
      case "stage_cocktail":
        time("Start", "start", true);
        time("End", "end", false);
        sheet.location = location(a) ?? "Location not set";
        detail("Atmosphere or style", str(a.atmosphere));
        if (str(a.instructions)) sheet.instructions.push({ label: "Instructions", value: str(a.instructions)! });
        break;
      case "stage_entrance":
        time("Guests enter the room", "guest_entry", false);
        if (a.entrance_none === true) sheet.times.push({ label: "Entrance", when: { kind: "sequence" } });
        else time("Entrance", "entrance", true);
        if (a.entrance_none === true) sheet.instructions.push({ label: "Entrance", value: "No formal entrance" });
        break;
      case "stage_dinner":
        time("Start", "start", true);
        time("End", "end", false);
        sheet.location = location(a) ?? "Location not set";
        detail("Meal style", { plated: "Plated", buffet: "Buffet", family_style: "Family style", stations: "Food stations", other: "Other" }[String(a.meal_style)] ?? undefined);
        detail("Dinner guests",
          a.guest_count_source === "basics" ? (typeof basics.guest_count === "number" ? `${basics.guest_count} (Event basics)` : "Same as Event basics (not entered yet)")
          : num(a.guest_count) !== undefined ? String(a.guest_count) : undefined);
        break;
      case "stage_party":
        time("Start", "start", true);
        time("End", "end", false);
        sheet.location = location(a) ?? "Location not set";
        detail("Additional evening guests", num(a.evening_guests) !== undefined ? String(a.evening_guests) : undefined);
        break;
      case "stage_closing":
        if (a.finish_source === "time") time("Finish", "finish", true);
        else if (a.finish_source === "basics_end") sheet.times.push({ label: "Finish (Event basics end)", when: serviceEnd ?? { kind: "missing" } });
        else if (a.finish_source === "discuss") sheet.times.push({ label: "Finish", when: { kind: "undecided" } });
        else sheet.times.push({ label: "Finish", when: { kind: "missing" } });
        if (str(a.closing_instructions)) sheet.instructions.push({ label: "Closing instructions", value: str(a.closing_instructions)! });
        break;
    }

    for (const m of s.moments) {
      const ans = answersOf(m.id);
      const rows = sheet.rows;
      const editor = m.editor === "processional" ? "processional" : m.editor;
      if (editor && isMusicEditor(editor)) {
        rows.push(...musicRows(m, editor, ans as MusicAnswers, s.label, base.musicLists, {
          // Processional people walking to a Couple entrance song are shown here, with it.
          linked: m.key === "couple_entrance" ? procPeople.filter((p) => p.song_id && coupleSongIds.has(p.song_id)) : [],
          // Entrance songs already shown with their Introductions aren't repeated (when Introductions is visible).
          skip: m.key === "entrance_music" ? new Set(introEntries.flatMap((e) => (e.song_id ? [e.song_id] : []))) : new Set<string>(),
        }));
        continue;
      }
      switch (editor) {
        case "processional": {
          const own = new Map((processionalAnswers.songs ?? []).map((x) => [x.id, x]));
          // People walking to a Couple entrance song are shown there, with that song.
          const walking = procPeople.filter((p) => !(p.song_id && coupleSongIds.has(p.song_id)));
          const groups = groupBySong(walking);
          const used = new Set<string>();
          groups.forEach((g, i) => {
            const linked = g.songId ? own.get(g.songId) : undefined;
            if (linked) used.add(linked.id);
            rows.push({
              id: `${m.id}:${i}`, when: { kind: "sequence" }, title: m.label, people: g.people,
              songs: linked ? [song(linked)!].filter(Boolean) : [], notes: g.notes, status: null,
              warning: linked ? undefined : g.songId ? undefined : "No song linked",
            });
          });
          const rest = (processionalAnswers.songs ?? []).filter((x) => !used.has(x.id));
          const choice = processionalAnswers.choice ? MOMENT_CHOICE[processionalAnswers.choice] : null;
          if (rest.length > 0 || groups.length === 0) {
            rows.push({
              id: `${m.id}:songs`, when: { kind: "sequence" }, title: groups.length ? `${m.label}: other songs` : `${m.label}: songs`, people: [],
              songs: songs(rest), notes: [], status: rest.length ? (processionalAnswers.choice === "discuss" ? MOMENT_CHOICE.discuss : null) : (choice ?? UNANSWERED),
            });
          }
          if (processionalAnswers.participants_choice === "discuss") rows.push({ id: `${m.id}:who`, when: { kind: "sequence" }, title: `${m.label}: who walks in`, people: [], songs: [], notes: [], status: MOMENT_CHOICE.discuss });
          break;
        }
        case "introductions": {
          const a2 = ans as IntroductionsAnswers;
          if (introEntries.length === 0) {
            rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes: [],
              status: a2.choice === "none" ? { tone: "none", text: "No introductions" } : a2.choice === "discuss" ? MOMENT_CHOICE.discuss : UNANSWERED });
            break;
          }
          groupBySong(introEntries).forEach((g, i) => {
            const linked = g.songId ? entranceSongs.get(g.songId) : undefined;
            rows.push({ id: `${m.id}:${i}`, when: { kind: "sequence" }, title: i === 0 ? m.label : `${m.label} (continued)`, people: g.people,
              songs: linked ? [song(linked)!].filter(Boolean) : [], notes: g.notes, status: null, warning: linked ? undefined : "No entrance song linked" });
          });
          if (a2.choice === "discuss") rows.push({ id: `${m.id}:discuss`, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes: [], status: MOMENT_CHOICE.discuss });
          break;
        }
        case "mc": {
          const mc = ans as McAnswers;
          const notes = str(mc.notes) ? [str(mc.notes)!] : [];
          if (mc.mc === "dj") rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [{ names: `${input.business.display_name} (the DJ)` }], songs: [], notes, status: null });
          else if (mc.mc === "other") rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [{ names: str(mc.name) ?? "Name not given", pronunciation: str(mc.pronunciation), role: str(mc.contact) }], songs: [], notes, status: null });
          else rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes,
            status: mc.mc === "none" ? { tone: "none", text: "No MC" } : mc.mc === "discuss" ? MOMENT_CHOICE.discuss : UNANSWERED });
          break;
        }
        case "speeches": {
          const sp = ans as SpeechesAnswers;
          const entries = (sp.entries ?? []).filter((e) => str(e.speaker));
          if (entries.length === 0) {
            rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes: [],
              status: sp.choice === "none" ? { tone: "none", text: "No speeches" } : sp.choice === "discuss" ? MOMENT_CHOICE.discuss : UNANSWERED });
            break;
          }
          for (const e of entries) {
            const when = speechWhen(e);
            rows.push({
              id: `${m.id}:${e.id}`, when, title: "Speech", people: [{ names: e.speaker, pronunciation: str(e.pronunciation), role: str(e.role) }], songs: [],
              notes: [e.duration ? `About ${e.duration} min` : null, str(e.av_notes) ? `AV: ${str(e.av_notes)}` : null, str(e.notes) ?? null].filter((x): x is string => Boolean(x)),
              status: null, warning: when.kind === "undecided" ? "Timing not decided" : undefined,
            });
          }
          if (sp.choice === "discuss") rows.push({ id: `${m.id}:discuss`, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes: [], status: MOMENT_CHOICE.discuss });
          break;
        }
        case "arrival": {
          const ar = ans as ArrivalAnswers;
          if (ar.arrival_none) {
            rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes: [], status: { tone: "none", text: "No separate arrival arrangements" } });
            break;
          }
          let when: When = { kind: "missing" };
          if (ar.time_source === "ceremony") when = (ceremony && at(ceremony, "guest_arrival")) ?? { kind: "missing" };
          else if (at(ar, "start")) when = at(ar, "start")!;
          const end = ar.time_source === "ceremony" ? null : at(ar, "end");
          const where = location(ar as Answers);
          rows.push({
            id: m.id, when, title: m.label, people: [], songs: [],
            notes: [
              ar.time_source === "ceremony" ? "Time: same as the ceremony's guest arrival" : null,
              end ? `Until ${whenText(end, date)}` : null,
              where ? `Where: ${where}` : null,
              str(ar.welcome) ? `Welcome: ${str(ar.welcome)}` : null,
              str(ar.announcement) ? `Announce: ${str(ar.announcement)}` : null,
            ].filter((x): x is string => Boolean(x)),
            status: Object.keys(ar).length === 0 ? UNANSWERED : null,
          });
          break;
        }
        case "program": {
          const pr = ans as TimedAnswers;
          const head = [
            at(pr as Answers, "end") ? `Ends ${whenText(at(pr as Answers, "end")!, date)}` : null,
            str(pr.notes) ? str(pr.notes)! : null,
          ].filter((x): x is string => Boolean(x));
          const host = str(pr.host);
          if (host || head.length || at(pr as Answers, "start")) {
            rows.push({ id: `${m.id}:head`, when: at(pr as Answers, "start") ?? { kind: "sequence" }, title: m.label,
              people: host ? [{ names: host, pronunciation: str(pr.host_pronunciation), role: "Host" }] : [], songs: [], notes: head, status: null });
          }
          rows.push(...timedRows(m.id, "program", pr, m.label));
          break;
        }
        case "activities":
          rows.push(...timedRows(m.id, "activities", ans as TimedAnswers, m.label));
          break;
        case "dedications":
          rows.push(...timedRows(m.id, "dedications", ans as TimedAnswers, m.label));
          break;
        case "music_style": {
          const ms = ans as MusicStyleAnswers;
          const notes = musicStyleText(ms);
          rows.push({ id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [], notes,
            status: ms.style_choice === "dj_choice" && notes.length <= 1 ? { tone: "choice", text: "DJ's choice of styles" } : notes.length === 0 ? UNANSWERED : null });
          break;
        }
        default:
          break; // stage-detail placeholders and covered moments: shown with their stage
      }
    }
    base.stages.push(sheet);
  }

  // -- Essentials: contacts, access, MC and officiant -----------------------
  const contactsItem = general.find((g) => g.editor === "contacts");
  const contacts = (contactsItem ? answersOf(contactsItem.id) : {}) as ContactsAnswers;
  if (contactsItem) {
    base.essentials.push(dayOfContact(contacts, view.event_contacts));
    base.vendors = contacts.vendors?.length
      ? { state: "listed", entries: contacts.vendors.map((v) => ({ role: roleLabel(v.role), name: [str(v.name), str(v.business)].filter(Boolean).join(", ") || "Name not given", phone: str(v.phone), email: str(v.email), notes: str(v.notes) })) }
      : { state: contacts.vendors_choice === "none" ? "none" : "unanswered", entries: [] };
  }
  base.essentials.push(
    basics.access_notes ? { label: "Access and load-in", value: basics.access_notes }
      : basics.access_notes_none ? { label: "Access and load-in", value: "No special instructions" }
      : { label: "Access and load-in", value: "Not answered yet", warn: true },
  );
  const where = [venueText, basics.venue_details, basics.venue_room ? `Room: ${basics.venue_room}` : null].filter(Boolean).join(" · ");
  base.essentials.push({ label: "Venue", value: where || "Not entered yet", warn: !where });
  const mcMoment = moment("mc");
  if (mcMoment) {
    const mc = answersOf(mcMoment.id) as McAnswers;
    base.essentials.push({
      label: "MC",
      value: mc.mc === "dj" ? `${input.business.display_name} (the DJ)`
        : mc.mc === "other" ? [str(mc.name) ?? "Name not given", str(mc.pronunciation) ? `[${str(mc.pronunciation)}]` : null, str(mc.contact)].filter(Boolean).join(" ")
        : mc.mc === "none" ? "No MC" : mc.mc === "discuss" ? "Discuss with DJ (still open)" : "Not answered yet",
      warn: !mc.mc || mc.mc === "discuss",
    });
  }
  if (ceremony && (str(ceremony.officiant_name) || str(ceremony.officiant_contact))) {
    base.essentials.push({ label: "Officiant", value: [str(ceremony.officiant_name), str(ceremony.officiant_contact)].filter(Boolean).join(" · ") });
  }

  // -- Preferences ------------------------------------------------------------
  base.preferences.push({ label: "Announcement language", value: labelOf(ANNOUNCEMENT_LANGUAGES, basics.announcement_language) ?? "Not answered yet" });
  const prefItem = general.find((g) => g.editor === "preferences");
  if (prefItem) {
    const p = answersOf(prefItem.id) as PreferencesAnswers;
    base.preferences.push(
      { label: "Explicit lyrics", value: labelOf(LYRICS, p.lyrics) ?? "Not answered yet" },
      { label: "Guest requests", value: labelOf(REQUESTS, p.requests) ?? "Not answered yet" },
      { label: "DJ interaction", value: labelOf(INTERACTION, p.interaction) ?? "Not answered yet" },
    );
    if (str(p.atmosphere)) base.preferences.push({ label: "Atmosphere", value: str(p.atmosphere)! });
    if (str(p.notes)) base.preferences.push({ label: "Other preferences", value: str(p.notes)! });
  }

  // -- Warnings ----------------------------------------------------------------
  for (const w of view.timeline_warnings) base.warnings.push({ kind: "timing", text: `${labelById.get(w.item_id) ?? "Timing"}: ${w.message}` });
  const stageMinutes = base.stages.flatMap((s) => s.times.map((t) => minutesOf(t.when))).filter((x): x is number => x !== null);
  if (serviceStart && stageMinutes.length && Math.min(...stageMinutes) < minutesOf(serviceStart)!) {
    base.warnings.push({ kind: "schedule", text: `Stage times start before the DJ service start in Event basics (${whenText(serviceStart, date)}). Check which applies.` });
  }
  if (serviceEnd && stageMinutes.length && Math.max(...stageMinutes) > minutesOf(serviceEnd)!) {
    base.warnings.push({ kind: "schedule", text: `Stage times run past the DJ service end in Event basics (${whenText(serviceEnd, date)}). Check which applies.` });
  }
  base.warnings.push(...songConflicts(base));
  // Open answers, one line per section: "Ceremony: Start time; Microphone needs (discuss with DJ)".
  for (const item of view.progress.items) {
    const open = item.requirements.filter((r) => r.state === "unanswered").map((r) => {
      const what = (item.key === "basics" ? BASICS_REQUIREMENT_LABELS[r.key] : undefined) ?? STAGE_REQUIREMENT_LABELS[r.key] ?? "Detail";
      const why = r.discuss ? "discuss with DJ" : r.note ? REQUIREMENT_NOTES[r.note]?.toLowerCase() : undefined;
      return why ? `${what} (${why})` : what;
    });
    if (open.length) base.warnings.push({ kind: "unresolved", text: `${labelById.get(item.item_id) ?? "Planning"}: ${open.join("; ")}` });
  }

  // -- Client editing (context only) ------------------------------------------
  const e = view.editing;
  if (e) base.editing = e.state === "open" ? `Client editing open until ${formatInstant(e.deadline, e.timezone)}.`
    : e.state === "reopened" ? `Client editing temporarily reopened until ${formatInstant(e.closes_at ?? e.deadline, e.timezone)}.`
    : `Client editing closed since ${formatInstant(e.deadline, e.timezone)}. Staff can still change the plan.`;

  // -- Frozen proposal answers ---------------------------------------------------
  if (view.imported && view.imported.questions.length > 0) {
    base.imported = {
      capturedAt: view.imported.captured_at,
      answers: view.imported.questions.map((q) => ({ label: q.prompt, value: formatImportedAnswer(q, view.imported!.answers) })),
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Consecutive people sharing one linked song become one group, so the song is shown once. */
function groupBySong(entries: Person[]): { songId: string | undefined; people: PersonLine[]; notes: string[] }[] {
  const groups: { songId: string | undefined; people: PersonLine[]; notes: string[] }[] = [];
  for (const e of entries) {
    const p = person(e);
    if (!p) continue;
    const last = groups[groups.length - 1];
    const notes = str(e.notes) ? [`${p.names}: ${str(e.notes)}`] : [];
    if (last && e.song_id && last.songId === e.song_id) {
      last.people.push(p);
      last.notes.push(...notes);
    } else groups.push({ songId: e.song_id, people: [p], notes });
  }
  return groups;
}

function musicRows(m: { id: string; key: string; label: string }, editor: MusicEditor | "processional", a: MusicAnswers, stageLabel: string, lists: MusicList[], opts: { linked: Person[]; skip: Set<string> }): Row[] {
  const list = songs(a.songs);
  const choice = a.choice;
  if (editor === "music_background" || editor === "music_requests" || editor === "music_exclusions") {
    const kind: MusicListKind = editor === "music_background" ? "background" : editor === "music_requests" ? "requests" : "exclusions";
    const status: Status | null = list.length ? null
      : choice === "dj_choice" ? { tone: "choice", text: "DJ's choice: no suggestions" }
      : choice === "none" ? { tone: "none", text: kind === "exclusions" ? "Nothing to exclude" : "No requests" }
      : UNANSWERED;
    lists.push({ id: m.id, key: m.key, label: m.label, stageLabel, kind, status, songs: list });
    return [{
      id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [],
      notes: list.length ? [`${list.length} ${list.length === 1 ? "song" : "songs"}: see ${kind === "exclusions" ? "Do not play" : "the full list"} in Music lists`] : [],
      status,
    }];
  }
  // Moment songs (and Entrance music / Couple entrance with the people linked to them).
  const byId = new Map((a.songs ?? []).map((s) => [s.id, s]));
  const rows: Row[] = [];
  const shown = new Set<string>();
  if (opts.linked.length) {
    for (const g of groupBySong(opts.linked)) {
      const s = g.songId ? byId.get(g.songId) : undefined;
      if (!s) continue;
      shown.add(s.id);
      rows.push({ id: `${m.id}:${s.id}`, when: { kind: "sequence" }, title: m.label, people: g.people, songs: [song(s)!].filter(Boolean), notes: g.notes, status: null });
    }
  }
  const rest = (a.songs ?? []).filter((s) => !shown.has(s.id) && !opts.skip.has(s.id));
  const skipped = (a.songs ?? []).length - shown.size - rest.length;
  if (skipped > 0 && rest.length === 0 && !choice) return rows; // every song is listed with the people it belongs to
  rows.push({
    id: `${m.id}:songs`, when: { kind: "sequence" }, title: rows.length || skipped ? `${m.label}: other songs` : m.label, people: [], songs: songs(rest), notes: [],
    status: rest.length ? (choice === "discuss" ? MOMENT_CHOICE.discuss : null) : choice ? (MOMENT_CHOICE[choice] ?? UNANSWERED) : rows.length ? null : UNANSWERED,
  });
  return rows.filter((r) => r.songs.length || r.status || r.people.length);
}

function speechWhen(e: Speech): When {
  if (e.timing === "time" && e.time) return { kind: "time", time: e.time, nextDay: e.next_day === true };
  if (e.timing === "cue" && str(e.cue)) return { kind: "cue", cue: str(e.cue)! };
  return { kind: "undecided" };
}

function timedWhen(e: TimedEntry): When {
  if (e.timing === "anytime") return { kind: "anytime" };
  if (e.timing === "time" && typeof e.time === "string") return { kind: "time", time: e.time, nextDay: e.next_day === true };
  if (e.timing === "cue" && str(e.cue)) return { kind: "cue", cue: str(e.cue)! };
  return { kind: "undecided" };
}

function timedRows(id: string, editor: "program" | "activities" | "dedications", a: TimedAnswers, label: string): Row[] {
  const entries = (a.entries ?? []) as TimedEntry[];
  if (entries.length === 0) {
    const none = { program: "No formal program", activities: "No activities", dedications: "No dedications" }[editor];
    if (editor === "program" && (str(a.host) || at(a as Answers, "start"))) return a.choice === "discuss" ? [{ id, when: { kind: "sequence" }, title: label, people: [], songs: [], notes: [], status: MOMENT_CHOICE.discuss }] : [];
    return [{ id, when: { kind: "sequence" }, title: label, people: [], songs: [], notes: [],
      status: a.choice === "none" ? { tone: "none", text: none } : a.choice === "discuss" ? MOMENT_CHOICE.discuss : UNANSWERED }];
  }
  const rows = entries.map((e): Row => {
    const when = timedWhen(e);
    const s = song({ title: e.song_title as string, artist: e.song_artist as string, version: e.song_version as string | undefined });
    const people: PersonLine[] = [];
    const notes: string[] = [];
    let title = label;
    if (editor === "program") {
      title = str(e.title) ?? label;
      if (str(e.presenter)) people.push({ names: str(e.presenter)!, pronunciation: str(e.pronunciation), role: "Presenter" });
      else if (str(e.pronunciation)) notes.push(`Pronunciation: ${str(e.pronunciation)}`);
    } else if (editor === "activities") {
      title = str(e.name) ?? label;
      if (str(e.host)) people.push({ names: str(e.host)!, role: "Host" });
      if (str(e.participants)) people.push({ names: str(e.participants)!, role: "Participants" });
      // The pronunciation guide belongs to the people named here; keep it next to them.
      if (str(e.pronunciation)) {
        if (people.length) people[people.length - 1].pronunciation = str(e.pronunciation);
        else notes.push(`Pronunciation: ${str(e.pronunciation)}`);
      }
    } else {
      title = `Dedication${str(e.relationship) ? ` (${str(e.relationship)})` : ""}`;
      if (str(e.recipient)) people.push({ names: str(e.recipient)!, pronunciation: str(e.pronunciation) });
      if (str(e.message)) notes.push(`Message: ${str(e.message)}`);
    }
    if (typeof e.duration === "number") notes.push(`About ${e.duration} min`);
    if (str(e.notes)) notes.push(str(e.notes)!);
    const missing = [
      when.kind === "undecided" ? "timing" : null,
      editor === "dedications" && !s ? "song" : null,
    ].filter(Boolean);
    return { id: `${id}:${String(e.id)}`, when, title, people, songs: s ? [s] : [], notes, status: null, warning: missing.length ? `Still needs: ${missing.join(" and ")}` : undefined };
  });
  if (a.choice === "discuss") rows.push({ id: `${id}:discuss`, when: { kind: "sequence" }, title: label, people: [], songs: [], notes: [], status: MOMENT_CHOICE.discuss });
  return rows;
}

function musicStyleText(ms: MusicStyleAnswers): string[] {
  const out: string[] = [];
  if (ms.style_choice === "dj_choice") out.push("Styles: DJ's choice");
  if (ms.genres?.length || str(ms.other_style)) {
    out.push(`Styles: ${[...(ms.genres ?? []).map((g) => labelOf(GENRES, g) ?? g), str(ms.other_style)].filter(Boolean).join(", ")}`);
  }
  if (str(ms.favorite_artists)) out.push(`Favourite artists: ${str(ms.favorite_artists)}`);
  if (str(ms.dance_floor)) out.push(`Dance floor: ${str(ms.dance_floor)}`);
  if (ms.slow_songs) out.push(`Slow songs: ${labelOf(SLOW_SONGS, ms.slow_songs) ?? ms.slow_songs}`);
  return out;
}

function dayOfContact(c: ContactsAnswers, contacts: EventContact[]): Pair & { phone?: string; warn?: boolean } {
  const label = "Day-of contact";
  if (c.day_of_source === "event_contact") {
    const who = contacts.find((x) => x.id === c.day_of_client_id);
    if (!who) return { label, value: "The chosen contact is no longer on this event", warn: true };
    const phone = str(c.day_of_phone) ?? who.phone ?? undefined;
    return { label, value: `${who.name}${phone ? ` · ${phone}` : " · no phone yet"}${str(c.day_of_phone) && who.phone && who.phone !== c.day_of_phone ? " (phone for the day)" : ""}`, phone, warn: !phone };
  }
  if (c.day_of_source === "other") {
    const phone = str(c.day_of_phone);
    const value = [str(c.day_of_name) ?? "Name not given", str(c.day_of_role), phone ?? "no phone yet"].filter(Boolean).join(" · ");
    return { label, value, phone, warn: !phone };
  }
  return { label, value: c.day_of_source === "undecided" ? "Not decided yet" : "Not answered yet", warn: true };
}

/** A song to play that is also on Do not play (title and artist, ignoring case and spacing only). */
function songConflicts(sheet: RunSheet): Warning[] {
  const banned = new Map<string, string>();
  for (const l of sheet.musicLists) if (l.kind === "exclusions") for (const s of l.songs) banned.set(matchKey(s), l.label);
  if (banned.size === 0) return [];
  const out: Warning[] = [];
  const seen = new Set<string>();
  const check = (s: SongLine, where: string) => {
    const hit = banned.get(matchKey(s));
    const key = `${matchKey(s)}|${where}`;
    if (hit && !seen.has(key)) {
      seen.add(key);
      out.push({ kind: "conflict", text: `"${s.title}" by ${s.artist} is on ${hit} and also in ${where}.` });
    }
  };
  for (const l of sheet.musicLists) if (l.kind !== "exclusions") for (const s of l.songs) check(s, `${l.stageLabel} · ${l.label}`);
  for (const st of sheet.stages) for (const r of st.rows) for (const s of r.songs) check(s, `${st.label} · ${r.title}`);
  return out;
}
