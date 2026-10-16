import { ANNOUNCEMENT_LANGUAGES, BASICS_REQUIREMENT_LABELS, endsAfterMidnight, type BasicsAnswers } from "@/lib/planning/basics";
import { GENRES, INTERACTION, LYRICS, REQUESTS, SLOW_SONGS, roleLabel, type ContactsAnswers, type EventContact, type MusicStyleAnswers, type PreferencesAnswers } from "@/lib/planning/contacts";
import { isMusicEditor, isPlaylistUrl, matchKey, playlistKind, type MusicAnswers, type MusicEditor, type Playlist, type Song } from "@/lib/planning/music";
import type { IntroductionsAnswers, McAnswers, Person, ProcessionalAnswers, Speech, SpeechesAnswers } from "@/lib/planning/participants";
import { GRAND_ENTRANCE_MOMENTS, grandEntranceOf, grandEntranceOpen, nextDayLabel, REQUIREMENT_NOTES, requirementLabel } from "@/lib/planning/stages";
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

/** `order`: the entry's place in an ordered list such as the processional (1 is first). */
export type PersonLine = { names: string; pronunciation?: string; role?: string; wording?: string; order?: number };
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
/**
 * A playlist link as the client saved it: `kind` is "Spotify playlist" (or
 * "Playlist link" for a service not recognized) and `host` the link's host,
 * for a short clickable label instead of the raw URL. Never fetched.
 */
export type PlaylistLine = { url: string; kind: string; host: string; label?: string; notes?: string };
export type MusicList = { id: string; key: string; label: string; stageLabel: string; kind: MusicListKind; status: Status | null; songs: SongLine[]; playlists: PlaylistLine[] };

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
    /** events.booking_source; "external" is booked elsewhere (no contract), "flux" or absent a Flux booking. */
    booking_source?: string;
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

function playlist(p: Partial<Playlist> | undefined): PlaylistLine | null {
  const url = str(p?.url);
  if (!url || !isPlaylistUrl(url)) return null;
  return { url, kind: playlistKind(url), host: new URL(url).hostname, label: str(p?.label), notes: str(p?.notes) };
}
const playlists = (list: unknown): PlaylistLine[] => (Array.isArray(list) ? list.map((p) => playlist(p as Playlist)).filter((p): p is PlaylistLine => p !== null) : []);

/** "2 playlists and 3 songs", "1 playlist", "4 songs". */
export function listCount(l: { songs: unknown[]; playlists: unknown[] }): string {
  const n = (count: number, one: string) => (count ? [`${count} ${count === 1 ? one : `${one}s`}`] : []);
  return [...n(l.playlists.length, "playlist"), ...n(l.songs.length, "song")].join(" and ");
}

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
      booked:
        event.booking_source === "external" ||
        (Boolean(event.booking_confirmed_at) && (event.lifecycle_status === "booked" || event.lifecycle_status === "completed")),
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
  const editorById = new Map<string, string | null>();
  for (const g of general) labelById.set(g.id, g.label);
  for (const s of stages) {
    labelById.set(s.id, s.label);
    for (const m of s.moments) {
      labelById.set(m.id, `${s.label} · ${m.label}`);
      editorById.set(m.id, m.editor);
    }
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
  const introAnswers = (introductions ? answersOf(introductions.id) : {}) as IntroductionsAnswers;
  const introEntries = (introAnswers.entries ?? []).filter((e) => str(e.names));
  // The grand entrance decision: its moments are shown only while it's planned
  // (or, before any decision, when they already hold answers), as on the planning pages.
  const entranceStage = stages.find((x) => x.editor === "stage_entrance");
  const grandEntrance = entranceStage ? grandEntranceOf((view.stage_details[entranceStage.id]?.answers ?? {}) as Answers) : null;
  const entranceSaved = Boolean(entranceStage?.moments.some((m) => GRAND_ENTRANCE_MOMENTS.includes(m.key) && Object.keys(answersOf(m.id)).length > 0));
  const entranceOpen = grandEntranceOpen(grandEntrance, entranceSaved);
  // Entrance order, numbered wherever the people are shown.
  const introOrder = new Map(introEntries.map((e, i) => [e.id, i + 1]));
  const processional = moment("processional");
  const processionalAnswers = (processional ? answersOf(processional.id) : {}) as ProcessionalAnswers;
  const procPeople = (processionalAnswers.participants ?? []).filter((p) => str(p.names));
  // Walking order, numbered wherever the people are shown (with a Couple entrance song too).
  const procOrder = new Map(procPeople.map((p, i) => [p.id, i + 1]));
  const coupleEntrance = stages.flatMap((s) => s.moments).find((m) => m.key === "couple_entrance");
  const coupleSongIds = new Set(((coupleEntrance ? (answersOf(coupleEntrance.id) as MusicAnswers).songs : undefined) ?? []).map((s) => s.id));
  const entranceMusic = stages.flatMap((s) => s.moments).find((m) => m.key === "entrance_music");
  const entranceSongs = new Map(((entranceMusic ? (answersOf(entranceMusic.id) as MusicAnswers).songs : undefined) ?? []).map((s) => [s.id, s]));
  // The grand entrance's own songs (entered with each introduction) come first; older plans link to Entrance music.
  for (const x of introAnswers.songs ?? []) entranceSongs.set(x.id, x);

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
        time("Guest arrival", "guest_arrival", true);
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
        // A grand entrance time kept while the entrance is skipped or undecided is never shown as planned.
        time("Guest entry", "guest_entry", true);
        if (grandEntrance === "planned" || grandEntrance === null) time("Grand entrance", "entrance", true);
        else if (grandEntrance === "undecided") sheet.times.push({ label: "Grand entrance", when: { kind: "undecided" } });
        if (str(a.location_area)) sheet.location = str(a.location_area)!;
        if (grandEntrance === "none") sheet.instructions.push({ label: "Grand entrance", value: "No formal grand entrance" });
        else if (grandEntrance === "undecided") sheet.instructions.push({ label: "Grand entrance", value: "Not decided yet (still open)" });
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
      // The grand entrance's moments when it's skipped or undecided: nothing to run (answers are kept).
      if (GRAND_ENTRANCE_MOMENTS.includes(m.key) && s.editor === "stage_entrance" && !entranceOpen) continue;
      if (editor && isMusicEditor(editor)) {
        rows.push(...musicRows(m, editor, ans as MusicAnswers, s.label, base.musicLists, {
          // Processional people walking to a Couple entrance song are shown here, with it.
          linked: m.key === "couple_entrance" ? procPeople.filter((p) => p.song_id && coupleSongIds.has(p.song_id)) : [],
          order: m.key === "couple_entrance" ? procOrder : undefined,
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
          const groups = groupBySong(walking, procOrder);
          const used = new Set<string>();
          // A song already played for earlier people: said as a fact; how to play it is the client's instruction, never inferred.
          const firstWith = new Map<string, PersonLine[]>();
          groups.forEach((g, i) => {
            const linked = g.songId ? own.get(g.songId) : undefined;
            if (linked) used.add(linked.id);
            const earlier = g.songId ? firstWith.get(g.songId) : undefined;
            if (g.songId && !earlier) firstWith.set(g.songId, g.people);
            rows.push({
              id: `${m.id}:${i}`, when: { kind: "sequence" }, title: i === 0 ? m.label : `${m.label} (continued)`, people: g.people,
              songs: linked ? [song(linked)!].filter(Boolean) : [],
              notes: [...(earlier ? [`Same song as ${earlier.map(numbered).join(", ")}`] : []), ...g.notes], status: null,
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
          // In entrance order; a song already played for earlier entries is said as a fact, never as a restart or continuation.
          const firstWith = new Map<string, PersonLine[]>();
          groupBySong(introEntries, introOrder).forEach((g, i) => {
            const linked = g.songId ? entranceSongs.get(g.songId) : undefined;
            const earlier = g.songId ? firstWith.get(g.songId) : undefined;
            if (g.songId && !earlier) firstWith.set(g.songId, g.people);
            // Music decided explicitly: a song, or the DJ's choice (never a made-up track). Neither is still open.
            const djChoice = !g.songId && g.entries[0]?.music === "dj_choice";
            rows.push({ id: `${m.id}:${i}`, when: { kind: "sequence" }, title: i === 0 ? m.label : `${m.label} (continued)`, people: g.people,
              songs: linked ? [song(linked)!].filter(Boolean) : [],
              notes: [...(earlier ? [`Same song as ${earlier.map(numbered).join(", ")}`] : []), ...g.notes],
              status: djChoice ? { tone: "choice", text: "DJ's choice" } : null,
              warning: linked || djChoice ? undefined : g.songId ? "Linked song not found" : "Music not decided yet" });
          });
          // Grand entrance songs no entry uses yet.
          const used = new Set(introEntries.flatMap((e) => (e.song_id ? [e.song_id] : [])));
          const rest = (introAnswers.songs ?? []).filter((x) => !used.has(x.id));
          if (rest.length > 0) rows.push({ id: `${m.id}:songs`, when: { kind: "sequence" }, title: `${m.label}: other songs`, people: [], songs: songs(rest), notes: [], status: null });
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
    // Moments the client said won't happen aren't on the timeline: they're named once with their stage.
    const skipped = sheet.rows.filter((r) => r.status === MOMENT_CHOICE.not_applicable);
    if (skipped.length > 0) {
      sheet.rows = sheet.rows.filter((r) => !skipped.includes(r));
      sheet.instructions.push({ label: "Not happening", value: skipped.map((r) => r.title.replace(/: songs$/, "")).join(", ") });
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
      const what = (item.key === "basics" ? BASICS_REQUIREMENT_LABELS[r.key] : undefined) ?? requirementLabel(r.key, editorById.get(item.item_id)) ?? "Detail";
      const why = r.discuss ? "discuss with DJ" : r.note ? REQUIREMENT_NOTES[r.note]?.toLowerCase() : undefined;
      return why ? `${what} (${why})` : what;
    });
    if (open.length) base.warnings.push({ kind: "unresolved", text: `${labelById.get(item.item_id) ?? "Planning"}: ${open.join("; ")}` });
  }

  // -- Client editing (context only) ------------------------------------------
  const e = view.editing;
  if (e) base.editing = e.state === "open" ? `Client editing open until ${formatInstant(e.deadline, e.timezone)}.`
    : e.state === "reopened" ? `Client editing temporarily reopened until ${formatInstant(e.closes_at ?? e.deadline, e.timezone)}.`
    : e.closed_at ? `Client editing closed by staff since ${formatInstant(e.closed_at, e.timezone)}. Staff can still change the plan.`
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

const numbered = (p: PersonLine) => (p.order ? `${p.order}. ${p.names}` : p.names);

/** Consecutive people sharing one linked song become one group, so the song is shown once. `order` numbers them. */
function groupBySong(entries: Person[], order?: Map<string, number>): { songId: string | undefined; people: PersonLine[]; notes: string[]; entries: Person[] }[] {
  const groups: { songId: string | undefined; people: PersonLine[]; notes: string[]; entries: Person[] }[] = [];
  for (const e of entries) {
    const found = person(e);
    if (!found) continue;
    const p: PersonLine = order?.get(e.id) ? { ...found, order: order.get(e.id) } : found;
    const last = groups[groups.length - 1];
    const notes = str(e.notes) ? [`${p.names}: ${str(e.notes)}`] : [];
    if (last && e.song_id && last.songId === e.song_id) {
      last.people.push(p);
      last.notes.push(...notes);
      last.entries.push(e);
    } else groups.push({ songId: e.song_id, people: [p], notes, entries: [e] });
  }
  return groups;
}

function musicRows(m: { id: string; key: string; label: string }, editor: MusicEditor | "processional", a: MusicAnswers, stageLabel: string, lists: MusicList[], opts: { linked: Person[]; skip: Set<string>; order?: Map<string, number> }): Row[] {
  const list = songs(a.songs);
  const choice = a.choice;
  if (editor === "music_background" || editor === "music_requests" || editor === "music_exclusions") {
    const kind: MusicListKind = editor === "music_background" ? "background" : editor === "music_requests" ? "requests" : "exclusions";
    const links = playlists(a.playlists);
    const status: Status | null = list.length || links.length ? null
      : choice === "dj_choice" ? { tone: "choice", text: "DJ's choice: no suggestions" }
      : choice === "none" ? { tone: "none", text: kind === "exclusions" ? "Nothing to exclude" : "No requests" }
      : UNANSWERED;
    const entry: MusicList = { id: m.id, key: m.key, label: m.label, stageLabel, kind, status, songs: list, playlists: links };
    lists.push(entry);
    return [{
      id: m.id, when: { kind: "sequence" }, title: m.label, people: [], songs: [],
      notes: list.length || links.length ? [`${listCount(entry)}: see ${kind === "exclusions" ? "Do not play" : "the full list"} in Music lists`] : [],
      status,
    }];
  }
  // Moment songs (and Entrance music / Couple entrance with the people linked to them).
  const byId = new Map((a.songs ?? []).map((s) => [s.id, s]));
  const rows: Row[] = [];
  const shown = new Set<string>();
  if (opts.linked.length) {
    for (const g of groupBySong(opts.linked, opts.order)) {
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
