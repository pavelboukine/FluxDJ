import { z } from "zod";
import type { BasicsAnswers } from "./basics";

/**
 * Shapes of the planning views returned by the database
 * (client_planning_view, staff_planning_view) and of save results. Parsed,
 * never trusted blindly, before rendering.
 */

const requirementSchema = z.object({
  key: z.string(),
  state: z.enum(["answered", "imported", "not_applicable", "unanswered"]),
  /** An open "discuss with DJ" (state stays unanswered). */
  discuss: z.boolean().optional(),
  /** Why a reuse choice can't be resolved yet (venue_unknown, basics_missing). */
  note: z.string().optional(),
});
export type Requirement = z.infer<typeof requirementSchema>;

const progressItemSchema = z.object({
  item_id: z.string(),
  key: z.string(),
  state: z.enum(["complete", "in_progress", "not_started", "not_available"]),
  requirements: z.array(requirementSchema),
  met: z.number().int(),
  total: z.number().int(),
});

export const progressSchema = z.object({
  scope: z.literal("available_sections_only"),
  items: z.array(progressItemSchema),
  requirements_total: z.number().int(),
  requirements_met: z.number().int(),
  percent: z.number().int().nullable(),
  available_sections: z.number().int(),
  complete_sections: z.number().int(),
  unavailable_sections: z.number().int(),
});
export type PlanProgress = z.infer<typeof progressSchema>;

const momentSchema = z.object({ id: z.string(), key: z.string(), label: z.string(), editor: z.string().nullable(), disabled: z.boolean() });
const stageSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  editor: z.string().nullable().optional(),
  disabled: z.boolean(),
  moments: z.array(momentSchema),
});
const generalSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  editor: z.string().nullable(),
  removable: z.boolean(),
  disabled: z.boolean(),
});
export const structureSchema = z.object({ general: z.array(generalSchema), stages: z.array(stageSchema) });
export type PlanStructure = z.infer<typeof structureSchema>;
export type PlanStage = z.infer<typeof stageSchema>;

const basicsAnswersSchema = z
  .object({
    guest_count: z.number().int().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    venue_details: z.string().optional(),
    venue_room: z.string().optional(),
    access_notes: z.string().optional(),
    access_notes_none: z.literal(true).optional(),
    announcement_language: z.enum(["french", "english", "bilingual", "other"]).optional(),
  })
  .transform((a) => a as BasicsAnswers);

const questionSchema = z.object({
  key: z.string(),
  prompt: z.string(),
  answer_type: z.enum(["boolean", "single_choice", "multi_choice", "short_text"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  required: z.boolean(),
});
export type ImportedQuestion = z.infer<typeof questionSchema>;

const importedSchema = z
  .object({ captured_at: z.string(), questions: z.array(questionSchema), answers: z.record(z.string(), z.unknown()) })
  .nullable();
export type Imported = z.infer<typeof importedSchema>;

const stageDetailsSchema = z.record(z.string(), z.object({ answers: z.record(z.string(), z.union([z.string(), z.number(), z.literal(true)])), revision: z.number().int() }));
export type StageDetails = z.infer<typeof stageDetailsSchema>;
const warningsSchema = z.array(z.object({ item_id: z.string(), key: z.string(), message: z.string() }));
export type TimelineWarning = z.infer<typeof warningsSchema>[number];

const eventSchema = z.object({
  id: z.string(),
  title: z.string(),
  event_type: z.string(),
  event_date: z.string(),
  timezone: z.string(),
  venue_name: z.string().nullable(),
  venue_address: z.string().nullable(),
});

export const clientPlanningViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }),
  z.object({
    state: z.literal("available"),
    brand: z.object({ display_name: z.string(), brand_colors: z.record(z.string(), z.string()) }),
    event: eventSchema,
    structure: structureSchema,
    basics: z.object({ item_id: z.string(), answers: basicsAnswersSchema, revision: z.number().int() }),
    stage_details: stageDetailsSchema,
    timeline_warnings: warningsSchema,
    imported: importedSchema,
    progress: progressSchema,
  }),
]);
export type ClientPlanningView = z.infer<typeof clientPlanningViewSchema>;

export const staffPlanningViewSchema = z.union([
  z.object({ plan: z.null() }),
  z.object({
    plan: z.object({
      id: z.string(),
      origin: z.enum(["template", "fallback"]),
      initialized_via: z.enum(["booking", "backfill", "staff"]),
      created_at: z.string(),
      source_template_id: z.string().nullable(),
      source_template_name: z.string().nullable(),
      structure_version: z.number().int(),
    }),
    structure: structureSchema,
    basics: z.object({
      item_id: z.string(),
      answers: basicsAnswersSchema,
      revision: z.number().int(),
      updated_by: z.enum(["client", "staff"]).nullable(),
      updated_at: z.string().nullable(),
    }),
    stage_details: stageDetailsSchema,
    timeline_warnings: warningsSchema,
    imported: importedSchema,
    progress: progressSchema,
  }),
]);
export type StaffPlanningView = z.infer<typeof staffPlanningViewSchema>;

/** Result of saving a plan item (Event basics or stage details), from the client or staff action. */
export type SaveItemResult =
  | { status: "saved"; revision: number; answers: Record<string, unknown>; progress: PlanProgress; timeline_warnings: TimelineWarning[] }
  | { status: "conflict" }
  | { status: "invalid"; field: string | null; message: string }
  | { status: "unavailable" }
  | { status: "signed_out" }
  | { status: "error"; message: string };

export const saveResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("saved"),
    revision: z.number().int(),
    answers: z.record(z.string(), z.unknown()),
    progress: progressSchema,
    timeline_warnings: warningsSchema,
  }),
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("invalid"), field: z.string().nullable(), message: z.string() }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("signed_out") }),
]);

/** How a frozen proposal answer reads. Missing answers are "Not answered", never "No". */
export function formatImportedAnswer(q: ImportedQuestion, answers: Record<string, unknown>): string {
  if (!Object.hasOwn(answers, q.key) || answers[q.key] === null || answers[q.key] === undefined) return "Not answered";
  const value = answers[q.key];
  const label = (v: unknown) => q.options.find((o) => o.value === v)?.label ?? String(v);
  switch (q.answer_type) {
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : "Not answered";
    case "single_choice":
      return typeof value === "string" ? label(value) : "Not answered";
    case "multi_choice":
      return Array.isArray(value) ? (value.length === 0 ? "None selected" : value.map(label).join(", ")) : "Not answered";
    case "short_text":
      return typeof value === "string" && value.trim() !== "" ? value : "Not answered";
  }
}

/** The headline for progress. Never claims planning is complete: it covers available sections only. */
export function progressHeadline(p: PlanProgress): string {
  if (p.requirements_total === 0) return "Nothing to fill in yet";
  // Most planning editors aren't built yet, so finishing what exists is never "planning complete".
  if (p.requirements_met === p.requirements_total) return "Available sections done";
  return `${p.requirements_met} of ${p.requirements_total} required answers`;
}

export function progressScopeNote(p: PlanProgress): string {
  const available = p.available_sections === 1 ? "1 section you can fill in now (Event basics)" : `${p.available_sections} sections you can fill in now`;
  return p.unavailable_sections > 0
    ? `Progress covers the ${available}. The other sections open later and aren't counted yet.`
    : `Progress covers the ${available}.`;
}

export function basicsProgress(p: PlanProgress) {
  return p.items.find((i) => i.key === "basics") ?? null;
}

export function itemProgress(p: PlanProgress, itemId: string) {
  return p.items.find((i) => i.item_id === itemId) ?? null;
}

export function formatEventDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
