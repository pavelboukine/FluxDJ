import { isMusicEditor } from "./music";
import { planSections } from "./navigation";
import { INCLUDED_IN, isMomentEditor } from "./participants";
import { isStageEditor } from "./stages";
import type { CustomQuestion } from "./custom-questions";
import type { PlanStructure } from "./view";

/**
 * A planning template seen the way an event plan copied from it would be:
 * the same general sections, stages and moments, in the saved order, with
 * the library's editors. Templates have no hidden items (an item is in the
 * template or not), so nothing is disabled. The client's sections then come
 * from the same planSections the client and staff planning pages use, so the
 * template screens describe and preview exactly what a new plan would show.
 */

/** `questions`: a custom section's or moment's own questions (null for library items and custom stages). */
export type TemplateItemRow = { id: string; kind: string; key: string; parent_id: string | null; label: string; position: number; questions?: unknown };

/** A DJ's own item (no library row): its key is custom_<random>, as private.is_custom_planning_key decides. */
export function isCustomKey(key: string): boolean {
  return /^custom_[a-z0-9]{8,40}$/.test(key);
}
export type LibraryEntry = {
  kind: string;
  key: string;
  parent_keys: string[] | null;
  default_label: string;
  description: string | null;
  editor: string | null;
  removable: boolean;
};

const byPosition = (a: TemplateItemRow, b: TemplateItemRow) => a.position - b.position || a.id.localeCompare(b.id);

export function templateStructure(items: TemplateItemRow[], library: LibraryEntry[]): PlanStructure {
  const lib = new Map(library.map((l) => [l.key, l]));
  const sorted = [...items].sort(byPosition);
  // As private.planning_item_info: the library's editor, "custom" for a DJ's own section or moment, none for a custom stage.
  const editor = (i: TemplateItemRow) => (isCustomKey(i.key) ? (i.kind === "stage" ? null : "custom") : (lib.get(i.key)?.editor ?? null));
  const questions = (i: TemplateItemRow) => (isCustomKey(i.key) && i.kind !== "stage" ? { questions: (Array.isArray(i.questions) ? i.questions : []) as CustomQuestion[] } : {});
  return {
    general: sorted
      .filter((i) => i.kind === "general")
      .map((g) => ({ id: g.id, key: g.key, label: g.label, editor: editor(g), removable: lib.get(g.key)?.removable ?? true, disabled: false, ...questions(g) })),
    stages: sorted
      .filter((i) => i.kind === "stage")
      .map((s) => ({
        id: s.id,
        key: s.key,
        label: s.label,
        editor: editor(s),
        disabled: false,
        moments: sorted.filter((m) => m.parent_id === s.id).map((m) => ({ id: m.id, key: m.key, label: m.label, editor: editor(m), disabled: false, ...questions(m) })),
      })),
  };
}

/**
 * What an item becomes in client planning, in plain words:
 *  - section: a section the client opens (general sections, stages with something to fill in);
 *  - fill: a moment the client fills in inside its stage; it counts toward planning progress;
 *  - details: a placeholder answered in its stage's details form;
 *  - covered: a placeholder answered in another moment (e.g. Participants and names in Introductions);
 *  - group: a stage that only groups its moments;
 *  - not_shown: not offered to clients (a stage with nothing to fill in, an item without an editor).
 */
export type ItemRole = { kind: "section" | "fill" | "details" | "covered" | "group" | "not_shown"; text: string };

export function itemRoles(structure: PlanStructure, library: LibraryEntry[]): Map<string, ItemRole> {
  const sections = new Map(planSections(structure).map((s) => [s.key, s]));
  const defaultLabel = new Map(library.map((l) => [l.key, l.default_label]));
  const roles = new Map<string, ItemRole>();
  const fills = (n: number) => `${n} moment${n === 1 ? "" : "s"} to fill in`;

  for (const g of structure.general) {
    roles.set(
      g.key,
      sections.has(g.key)
        ? { kind: "section", text: g.removable ? "A section clients fill in. Counts toward planning progress." : "A section clients fill in. Every plan has it, so it can't be removed." }
        : { kind: "not_shown", text: "Not shown to clients: it can't be filled in yet." },
    );
  }
  for (const s of structure.stages) {
    const section = sections.get(s.key);
    if (!section) {
      roles.set(s.key, {
        kind: "not_shown",
        text: s.moments.length === 0 ? "Not shown to clients until it has a moment to fill in." : "Not shown to clients: none of its moments has anything of its own to fill in.",
      });
    } else if (section.stageEditor) {
      roles.set(s.key, {
        kind: "section",
        text: `A client section: the stage's own details${section.moments.length > 0 ? ` and ${fills(section.moments.length)}` : ""}. Counts toward planning progress.`,
      });
    } else {
      roles.set(s.key, { kind: "group", text: `A client section with ${fills(section.moments.length)}. The stage itself has no questions.` });
    }
    for (const m of s.moments) {
      if (isMusicEditor(m.editor) || isMomentEditor(m.editor) || m.editor === "custom") {
        roles.set(m.key, { kind: "fill", text: "Clients fill this in. Counts toward planning progress." });
      } else if (m.editor === "stage_details" && isStageEditor(s.editor)) {
        roles.set(m.key, { kind: "details", text: `Asked in the ${s.label} details, not as a separate moment.` });
      } else if (m.editor === "included") {
        const target = INCLUDED_IN[m.key];
        const by = s.moments.find((x) => x.key === target);
        roles.set(m.key, {
          kind: "covered",
          text: by
            ? `Answered in ${by.label}. Clients see it as a pointer, not a separate task.`
            : `Answered in ${defaultLabel.get(target) ?? "another moment"}, which isn't in this stage. Add it to collect this information.`,
        });
      } else {
        roles.set(m.key, { kind: "not_shown", text: "Not shown to clients: it can't be filled in yet." });
      }
    }
  }
  return roles;
}

/** Library items this template doesn't have, by where they could be added. Moments are listed under each stage of the template they fit. */
export function addableItems(structure: PlanStructure, library: LibraryEntry[]) {
  const present = new Set([...structure.general.map((g) => g.key), ...structure.stages.flatMap((s) => [s.key, ...s.moments.map((m) => m.key)])]);
  const missing = library.filter((l) => !present.has(l.key));
  return {
    general: missing.filter((l) => l.kind === "general"),
    stages: missing.filter((l) => l.kind === "stage"),
    momentsFor: (stageKey: string) => missing.filter((l) => l.kind === "moment" && (l.parent_keys ?? []).includes(stageKey)),
  };
}

/** Counts for summaries ("3 general sections · 7 stages · 32 moments"). */
export function structureCounts(items: { kind: string }[]) {
  const n = (kind: string) => items.filter((i) => i.kind === kind).length;
  return { general: n("general"), stages: n("stage"), moments: n("moment") };
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
