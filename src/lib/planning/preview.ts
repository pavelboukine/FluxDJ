import type { ClientEditing } from "./cutoff";
import type { CustomQuestion } from "./custom-questions";
import type { ClientPlanningView, PlanProgress, PlanStructure, StaffPlanningView } from "./view";

/**
 * Client planning views for staff previews (see ClientPlanningWorkspace): the shape the client's
 * page renders, built from what staff can already read. Nothing here reads or writes the database.
 *
 * - templatePreviewView: a planning template on a clearly labelled sample event, with no answers.
 * - eventPreviewView: an event's own plan as its client would get it: only what the client sees
 *   (hidden items left out, as client_planning_view does), with the answers saved so far.
 */

type AvailableView = Extract<ClientPlanningView, { state: "available" }>;
type Brand = { displayName: string; brandColors: Record<string, string> };

const EMPTY_PROGRESS: PlanProgress = {
  scope: "available_sections_only",
  items: [],
  requirements_total: 0,
  requirements_met: 0,
  percent: null,
  available_sections: 0,
  complete_sections: 0,
  unavailable_sections: 0,
};

/** The sample event a template preview shows: named as a sample, three months out, at a sample venue. */
export const SAMPLE_EVENT = { title: "Sample event", venueName: "Sample venue", daysAhead: 90 } as const;

function isoDatePlusDays(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function templatePreviewView(opts: {
  structure: PlanStructure;
  brand: Brand;
  djName: string | null;
  eventType: string | null;
  timezone: string;
  /** Today in the business's time zone (YYYY-MM-DD). */
  today: string;
}): AvailableView {
  const basics = opts.structure.general.find((g) => g.key === "basics");
  return {
    state: "available",
    brand: { display_name: opts.brand.displayName, brand_colors: opts.brand.brandColors },
    dj_name: opts.djName,
    event: {
      id: "preview",
      title: SAMPLE_EVENT.title,
      event_type: opts.eventType ?? "wedding",
      event_date: isoDatePlusDays(opts.today, SAMPLE_EVENT.daysAhead),
      timezone: opts.timezone,
      venue_name: SAMPLE_EVENT.venueName,
      venue_address: null,
    },
    // No deadline or read-only state: a sample event is always open.
    editing: null,
    structure: opts.structure,
    basics: { item_id: basics?.id ?? "preview-basics", answers: {}, revision: 0 },
    stage_details: {},
    music: {},
    moments: {},
    event_contacts: [],
    timeline_warnings: [],
    imported: null,
    progress: EMPTY_PROGRESS,
  };
}

/**
 * Only what the client sees, as client_planning_view does: hidden sections, stages and moments are left
 * out, and so are custom questions staff removed (archived options stay, so a saved choice still reads).
 */
export function clientVisibleStructure(structure: PlanStructure): PlanStructure {
  const asked = <T extends { questions?: CustomQuestion[] }>(i: T): T => (i.questions ? { ...i, questions: i.questions.filter((q) => !q.archived) } : i);
  return {
    general: structure.general.filter((g) => !g.disabled).map(asked),
    stages: structure.stages.filter((s) => !s.disabled).map((s) => ({ ...s, moments: s.moments.filter((m) => !m.disabled).map(asked) })),
  };
}

export function eventPreviewView(opts: {
  view: Extract<StaffPlanningView, { plan: object }>;
  event: { id: string; title: string; event_type: string; event_date: string; timezone: string; venue_name: string | null; venue_address: string | null };
  brand: Brand;
  /** The event's DJ name, else the business's (as client_planning_view resolves it). */
  djName: string | null;
}): AvailableView {
  const v = opts.view;
  // The client's editing state is a subset of the staff one: the same deadline, closing and closed-by-DJ facts.
  const editing: ClientEditing | null = v.editing
    ? { state: v.editing.state, deadline: v.editing.deadline, closes_at: v.editing.closes_at, closed_by_dj: v.editing.closed_by_dj, timezone: v.editing.timezone }
    : null;
  return {
    state: "available",
    brand: { display_name: opts.brand.displayName, brand_colors: opts.brand.brandColors },
    dj_name: opts.djName,
    event: opts.event,
    editing,
    structure: clientVisibleStructure(v.structure),
    basics: { item_id: v.basics.item_id, answers: v.basics.answers, revision: v.basics.revision },
    stage_details: v.stage_details,
    music: v.music,
    moments: v.moments,
    event_contacts: v.event_contacts,
    timeline_warnings: [],
    imported: v.imported,
    progress: EMPTY_PROGRESS,
  };
}
