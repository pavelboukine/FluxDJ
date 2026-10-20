import { z } from "zod";
import type { BasicsAnswers } from "./basics";
import { clientEditingSchema, staffEditingSchema, type ClientEditing } from "./cutoff";

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
const songSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  version: z.string().optional(),
  link: z.string().optional(),
  notes: z.string().optional(),
  cue: z.string().optional(),
});
const playlistSchema = z.object({ id: z.string(), url: z.string(), label: z.string().optional(), notes: z.string().optional() });
/** Songs (and the lists' playlist links) of visible music moments, keyed by item id. Optional: a database without music editors omits it. */
const musicSchema = z
  .record(z.string(), z.object({
    answers: z.object({
      songs: z.array(songSchema).optional(),
      playlists: z.array(playlistSchema).optional(),
      choice: z.enum(["dj_choice", "none", "not_applicable", "discuss"]).optional(),
    }),
    revision: z.number().int(),
  }))
  .optional()
  .default({});
export type MusicLists = z.infer<typeof musicSchema>;
/**
 * Answers of visible participant, MC and speech moments (validated by the
 * database), keyed by item id. Optional: older databases omit it.
 */
const momentsSchema = z
  .record(z.string(), z.object({ answers: z.record(z.string(), z.unknown()), revision: z.number().int() }))
  .optional()
  .default({});
export type MomentAnswers = z.infer<typeof momentsSchema>;
/** This event's contacts (client-safe: name and phone). Optional: older databases omit it. */
const eventContactsSchema = z
  .array(z.object({ id: z.string(), name: z.string(), phone: z.string().nullable(), primary: z.boolean() }))
  .optional()
  .default([]);
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
  /** Booked, but staff haven't set planning up yet (Event basics only from booking): nothing to fill in. */
  z.object({
    state: z.literal("setting_up"),
    brand: z.object({ display_name: z.string(), brand_colors: z.record(z.string(), z.string()) }),
    event: eventSchema,
  }),
  z.object({
    state: z.literal("available"),
    brand: z.object({ display_name: z.string(), brand_colors: z.record(z.string(), z.string()) }),
    /** The DJ handling the event (its own name, else the business's DJ name), or null. */
    dj_name: z.string().nullable().optional(),
    event: eventSchema,
    /** Whether the client can edit now. Optional: a database without the cutoff omits it. */
    editing: clientEditingSchema.nullable().optional().default(null),
    structure: structureSchema,
    basics: z.object({ item_id: z.string(), answers: basicsAnswersSchema, revision: z.number().int() }),
    stage_details: stageDetailsSchema,
    music: musicSchema,
    moments: momentsSchema,
    event_contacts: eventContactsSchema,
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
    editing: staffEditingSchema.nullable().optional().default(null),
    structure: structureSchema,
    basics: z.object({
      item_id: z.string(),
      answers: basicsAnswersSchema,
      revision: z.number().int(),
      updated_by: z.enum(["client", "staff"]).nullable(),
      updated_at: z.string().nullable(),
    }),
    stage_details: stageDetailsSchema,
    music: musicSchema,
    moments: momentsSchema,
    event_contacts: eventContactsSchema,
    timeline_warnings: warningsSchema,
    imported: importedSchema,
    progress: progressSchema,
  }),
]);
export type StaffPlanningView = z.infer<typeof staffPlanningViewSchema>;

/**
 * Booking set the plan up with Event basics only (no template was the
 * default) and staff haven't configured it: no template applied and nothing
 * enabled besides Event basics. Clients can't open or save it until staff set
 * it up (private.plan_awaiting_setup enforces the same rule).
 */
export function planAwaitingSetup(view: StaffPlanningView): boolean {
  if (view.plan === null) return false;
  if (view.plan.origin !== "fallback" || view.plan.initialized_via === "staff") return false;
  const { general, stages } = view.structure;
  return (
    general.every((g) => g.key === "basics" || g.disabled) &&
    stages.every((s) => s.disabled && s.moments.every((m) => m.disabled))
  );
}

/** Result of saving a plan item (Event basics or stage details), from the client or staff action. */
export type SaveItemResult =
  | { status: "saved"; revision: number; answers: Record<string, unknown>; progress: PlanProgress; timeline_warnings: TimelineWarning[] }
  | { status: "conflict" }
  | { status: "invalid"; field: string | null; message: string }
  | { status: "unavailable" }
  | { status: "signed_out" }
  /** The client deadline has passed (or a reopening ended): nothing was saved. */
  | { status: "locked"; editing: ClientEditing }
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
  z.object({ status: z.literal("locked"), editing: clientEditingSchema }),
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

/**
 * Progress as a whole percentage, from the database's own counts (the same
 * requirements, "discuss" and not-applicable rules; nothing recounted here):
 * rounded to the nearest percent, but never 0% once something is answered
 * nor 100% while something is open. Null when there is nothing to fill in.
 * Display only: it never decides whether anything is complete.
 */
export function progressPercent(p: PlanProgress): number | null {
  if (p.requirements_total <= 0) return null;
  if (p.requirements_met <= 0) return 0;
  if (p.requirements_met >= p.requirements_total) return 100;
  return Math.min(99, Math.max(1, Math.round((p.requirements_met * 100) / p.requirements_total)));
}

/** "43% complete", or null when there is nothing to fill in. */
export function progressPercentText(p: PlanProgress): string | null {
  const percent = progressPercent(p);
  return percent === null ? null : `${percent}% complete`;
}

/** The count behind the percentage: "18 of 42 required answers". It covers available sections only (see progressScopeNote). */
export function progressHeadline(p: PlanProgress): string {
  if (p.requirements_total === 0) return "Nothing to fill in yet";
  return `${p.requirements_met} of ${p.requirements_total} required answers`;
}

/** Percentage and count on one line, for compact summaries: "43% complete · 18 of 42 required answers". */
export function progressSummaryLine(p: PlanProgress): string {
  const percent = progressPercentText(p);
  return percent ? `${percent} · ${progressHeadline(p)}` : progressHeadline(p);
}

/**
 * What progress covers. The database counts plan items (each section's details and moments,
 * "available_sections"), not the sections people navigate, so this says "planning items".
 */
export function progressScopeNote(p: PlanProgress): string {
  const available = p.available_sections === 1 ? "1 planning item open now (Event basics)" : `${p.available_sections} planning items open now`;
  return p.unavailable_sections > 0
    ? `Progress covers the ${available}. The other items open later and aren't counted yet.`
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

/** Every item's saved answers by item id (moments, music lists, stage details and Event basics), for answer previews. */
export function savedAnswersByItem(view: { moments: MomentAnswers; music: MusicLists; stage_details: StageDetails; basics?: { item_id: string; answers: Record<string, unknown> } }): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, v] of Object.entries(view.stage_details)) out[id] = v.answers;
  for (const [id, v] of Object.entries(view.music)) out[id] = v.answers as Record<string, unknown>;
  for (const [id, v] of Object.entries(view.moments)) out[id] = v.answers;
  if (view.basics) out[view.basics.item_id] = view.basics.answers;
  return out;
}
