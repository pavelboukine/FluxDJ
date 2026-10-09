import { isMusicEditor } from "./music";
import { INCLUDED_IN, isMomentEditor } from "./participants";
import { isStageEditor } from "./stages";
import { itemProgress, type PlanProgress, type PlanStructure, type TimelineWarning } from "./view";

/**
 * The client's planning, split into sections that open one at a time: the
 * general sections, then the stages, in the plan's configured order and with
 * its labels. Sections are identified by their library key (unique within a
 * plan), never by a label. Hidden items are already left out by the database.
 *
 * Statuses only summarize the database's per-item progress (requirement
 * states, "discuss with DJ" and timing warnings); nothing here decides
 * whether an answer counts.
 */

/** The query parameter naming the open section; absent means the overview. */
export const SECTION_PARAM = "section";
/** Extra views (not plan sections). Library keys never contain "-", so these can't collide with a section. */
export const PROVIDED_SECTION = "already-provided";
export const CLIENT_EDITING_SECTION = "client-editing";
export const STRUCTURE_SECTION = "plan-structure";

/** Element ids of a view's panel and heading (null is the overview), and of the area the views open in. */
export const panelId = (view: string | null) => `plan-panel-${view ?? "overview"}`;
export const headingId = (view: string | null) => `plan-heading-${view ?? "overview"}`;
export const WORKSPACE_ID = "plan-workspace";

/** General sections with an editor; others aren't offered as sections. */
const GENERAL_EDITORS = ["basics", "contacts", "preferences"];

export type SectionMoment = { id: string; key: string; label: string; editor: string };

export type PlanSection = {
  key: string;
  /** The general section's or stage's plan item id. */
  id: string;
  label: string;
  kind: "general" | "stage";
  /** The stage's own details editor, when it has one. */
  stageEditor: string | null;
  /** The label of the moment its details editor covers (e.g. "Ceremony details"), if visible. */
  detailsLabel: string | null;
  /** Visible moments with their own editor, in configured order. */
  moments: SectionMoment[];
  /** Labels of visible moments that can't be filled in yet. */
  unavailable: string[];
  /** Visible moments answered inside another moment's editor: a pointer, not a task. */
  covered: { label: string; by: string | null }[];
  /** Items whose progress the section shows, in display order. */
  itemIds: string[];
};

export function planSections(structure: PlanStructure): PlanSection[] {
  const general: PlanSection[] = structure.general
    .filter((g) => !g.disabled && g.editor !== null && GENERAL_EDITORS.includes(g.editor))
    .map((g) => ({ key: g.key, id: g.id, label: g.label, kind: "general", stageEditor: null, detailsLabel: null, moments: [], unavailable: [], covered: [], itemIds: [g.id] }));
  const stages: PlanSection[] = [];
  for (const s of structure.stages) {
    if (s.disabled) continue;
    const visible = s.moments.filter((m) => !m.disabled);
    const moments = visible
      .filter((m) => isMusicEditor(m.editor) || isMomentEditor(m.editor))
      .map((m) => ({ id: m.id, key: m.key, label: m.label, editor: m.editor as string }));
    const stageEditor = isStageEditor(s.editor) ? (s.editor as string) : null;
    // A container with nothing to fill in is not a section (no empty forms).
    if (!stageEditor && moments.length === 0) continue;
    stages.push({
      key: s.key,
      id: s.id,
      label: s.label,
      kind: "stage",
      stageEditor,
      detailsLabel: stageEditor ? (visible.find((m) => m.editor === "stage_details")?.label ?? null) : null,
      moments,
      unavailable: visible.filter((m) => m.editor === null).map((m) => m.label),
      covered: visible
        .filter((m) => m.editor === "included")
        .map((m) => ({ label: m.label, by: moments.find((x) => x.key === INCLUDED_IN[m.key])?.label ?? null })),
      itemIds: [...(stageEditor ? [s.id] : []), ...moments.map((m) => m.id)],
    });
  }
  return [...general, ...stages];
}

export type SectionState = "complete" | "not_applicable" | "in_progress" | "not_started" | "nothing";

export type SectionStatus = {
  state: SectionState;
  met: number;
  total: number;
  /** Open "discuss with DJ" answers. */
  discuss: number;
  /** Timing notes to check. */
  warnings: number;
  /** The first item still needing an answer (or with a timing note), for focusing. */
  firstOpenItem: string | null;
};

export function sectionStatus(section: PlanSection, progress: PlanProgress, warnings: TimelineWarning[]): SectionStatus {
  const items = section.itemIds.map((id) => itemProgress(progress, id)).filter((i) => i !== null);
  const met = items.reduce((n, i) => n + i.met, 0);
  const total = items.reduce((n, i) => n + i.total, 0);
  const requirements = items.flatMap((i) => i.requirements);
  const discuss = requirements.filter((r) => r.discuss).length;
  const warned = section.itemIds.filter((id) => warnings.some((w) => w.item_id === id));
  const open = items.find((i) => i.met < i.total)?.item_id ?? warned[0] ?? null;
  let state: SectionState;
  if (total === 0) state = "nothing";
  else if (met === total) state = requirements.every((r) => r.state === "not_applicable") ? "not_applicable" : "complete";
  else if (met > 0 || items.some((i) => i.state === "in_progress" || i.state === "complete")) state = "in_progress";
  else state = "not_started";
  return { state, met, total, discuss, warnings: warnings.filter((w) => section.itemIds.includes(w.item_id)).length, firstOpenItem: open };
}

export function isIncomplete(status: SectionStatus): boolean {
  return status.state === "in_progress" || status.state === "not_started";
}

/** The first section, in plan order, with required answers still open; null when everything available is answered. */
export function firstIncompleteSection(sections: PlanSection[], progress: PlanProgress, warnings: TimelineWarning[]): PlanSection | null {
  return sections.find((s) => isIncomplete(sectionStatus(s, progress, warnings))) ?? null;
}

/** The open view for a query value: a section key, an extra view, or null for the overview (also for unknown or hidden keys). */
export function resolveSection(value: string | null, sections: PlanSection[], extras: string[] = []): string | null {
  if (!value) return null;
  if (extras.includes(value)) return value;
  return sections.some((s) => s.key === value) ? value : null;
}

/** Views in reading order: the overview (null), every section, then the extra views (proposal answers, settings). */
export function viewOrder(sections: PlanSection[], extras: string[] = []): (string | null)[] {
  return [null, ...sections.map((s) => s.key), ...extras];
}

export function neighbours(sections: PlanSection[], extras: string[], active: string | null) {
  const order = viewOrder(sections, extras);
  const i = order.indexOf(active);
  return {
    previous: i > 0 ? { key: order[i - 1] } : null,
    next: i >= 0 && i < order.length - 1 ? { key: order[i + 1] } : null,
  };
}

/** The URL search string for a view, keeping unrelated parameters. */
export function sectionSearch(current: string, key: string | null): string {
  const params = new URLSearchParams(current);
  if (key) params.set(SECTION_PARAM, key);
  else params.delete(SECTION_PARAM);
  const s = params.toString();
  return s ? `?${s}` : "";
}
