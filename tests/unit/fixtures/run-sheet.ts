import { randomUUID } from "node:crypto";
import type { RunSheetInput } from "@/lib/run-sheet/model";
import type { StaffPlanningView } from "@/lib/planning/view";

/**
 * Builds staff_planning_view-shaped data for run-sheet tests: items with
 * library keys and editors, their saved answers, hidden items and progress.
 * Shapes follow the database's view (see src/lib/planning/view.ts).
 */
type MomentSpec = { key: string; editor: string | null; label: string; answers?: Record<string, unknown>; disabled?: boolean };
type StageSpec = { key: string; editor: string | null; label: string; answers?: Record<string, unknown>; disabled?: boolean; moments: MomentSpec[] };
type GeneralSpec = { key: string; editor: string; label: string; answers?: Record<string, unknown>; disabled?: boolean };

const MOMENT_EDITORS = ["processional", "mc", "introductions", "speeches", "contacts", "preferences", "music_style", "arrival", "program", "activities", "dedications"];
const MUSIC_EDITORS = ["music_background", "music_requests", "music_exclusions", "moment_songs", "processional"];

export const id = () => randomUUID();

export function planView(spec: {
  basics?: Record<string, unknown>;
  general?: GeneralSpec[];
  stages: StageSpec[];
  eventContacts?: { id: string; name: string; phone: string | null; primary: boolean }[];
  warnings?: { stageKey: string; message: string }[];
  unanswered?: { stageKey: string; key: string; note?: string; discuss?: boolean }[];
  imported?: { questions: { key: string; prompt: string; answer_type: "boolean" | "single_choice" | "multi_choice" | "short_text"; options: { value: string; label: string }[]; required: boolean }[]; answers: Record<string, unknown> } | null;
  editing?: "open" | "closed" | "reopened";
}): StaffPlanningView {
  const basicsId = id();
  const general = [{ id: basicsId, key: "basics", label: "Event basics", editor: "basics", removable: false, disabled: false }];
  const moments: Record<string, { answers: Record<string, unknown>; revision: number }> = {};
  const music: Record<string, { answers: { songs?: never[]; choice?: never }; revision: number }> = {};
  const stageDetails: Record<string, { answers: Record<string, string | number | true>; revision: number }> = {};
  const idByKey = new Map<string, string>();
  for (const g of spec.general ?? []) {
    const gid = id();
    idByKey.set(g.key, gid);
    general.push({ id: gid, key: g.key, label: g.label, editor: g.editor, removable: true, disabled: Boolean(g.disabled) });
    if (!g.disabled && g.answers) moments[gid] = { answers: g.answers, revision: 1 };
  }
  const stages = spec.stages.map((s) => {
    const sid = id();
    idByKey.set(s.key, sid);
    if (!s.disabled && s.answers) stageDetails[sid] = { answers: s.answers as Record<string, string | number | true>, revision: 1 };
    return {
      id: sid, key: s.key, label: s.label, editor: s.editor, disabled: Boolean(s.disabled),
      moments: s.moments.map((m) => {
        const mid = id();
        idByKey.set(m.key, mid);
        if (!s.disabled && !m.disabled && m.answers) {
          if (MOMENT_EDITORS.includes(m.editor ?? "")) moments[mid] = { answers: m.answers, revision: 1 };
          if (MUSIC_EDITORS.includes(m.editor ?? "")) music[mid] = { answers: m.answers as never, revision: 1 };
        }
        return { id: mid, key: m.key, label: m.label, editor: m.editor, disabled: Boolean(m.disabled) };
      }),
    };
  });
  const progressItems = (spec.unanswered ?? []).map((u) => ({
    item_id: idByKey.get(u.stageKey) ?? basicsId, key: u.stageKey, state: "in_progress" as const,
    requirements: [{ key: u.key, state: "unanswered" as const, note: u.note, discuss: u.discuss }], met: 0, total: 1,
  }));
  const editingState = spec.editing ?? "open";
  return {
    plan: { id: id(), origin: "template", initialized_via: "booking", created_at: "2026-09-01T12:00:00Z", source_template_id: id(), source_template_name: "Wedding", structure_version: 3 },
    editing: {
      state: editingState, deadline: "2027-07-31T04:00:00+00:00", closes_at: editingState === "closed" ? null : "2027-07-31T04:00:00+00:00", closed_by_dj: false, closed_at: null, timezone: "America/Toronto",
      now: "2026-10-07T15:04:00+00:00", cutoff_days: 14, business_days: 14, expected_deadline: "2027-07-31T04:00:00+00:00", schedule_changed: false,
      reopened_until: null, reopen_active: false, reopen_max_days: 14, version: 1,
      history: [{ action: "planning_client_reopened", at: "2026-10-01T12:00:00Z", actor: "staff-secret@example.test", reason: "SECRET AUDIT REASON", before: null, after: null }],
    },
    structure: { general, stages },
    basics: { item_id: basicsId, answers: (spec.basics ?? {}) as never, revision: 1, updated_by: "client", updated_at: "2026-09-02T12:00:00Z" },
    stage_details: stageDetails,
    music: music as never,
    moments,
    event_contacts: spec.eventContacts ?? [],
    timeline_warnings: (spec.warnings ?? []).map((w) => ({ item_id: idByKey.get(w.stageKey)!, key: w.stageKey, message: w.message })),
    imported: spec.imported ? { captured_at: "2026-09-01T12:00:00Z", ...spec.imported } : null,
    progress: {
      scope: "available_sections_only", items: progressItems, requirements_total: progressItems.length, requirements_met: 0, percent: 0,
      available_sections: progressItems.length, complete_sections: 0, unavailable_sections: 0,
    },
  } as StaffPlanningView;
}

export function input(view: StaffPlanningView, event: Partial<RunSheetInput["event"]> = {}, business = "BOUPROD Test"): RunSheetInput {
  return {
    business: { display_name: business, brand_colors: { primary: "#7c3aed" } },
    event: {
      title: "Test wedding", event_type: "wedding", event_date: "2027-08-14", timezone: "America/Toronto", venue_name: "Château Montebello",
      venue_address: "392 rue Notre-Dame, Montebello (Québec)", archived_at: null, booking_confirmed_at: "2026-09-01T12:00:00Z", lifecycle_status: "booked",
      ...event,
    },
    view,
    eventTypeLabel: "Wedding",
  };
}

export const song = (title: string, artist: string, extra: Record<string, string> = {}) => ({ id: id(), title, artist, ...extra });
