import { z } from "zod";

/**
 * Client planning deadline and temporary reopening, as computed by the
 * database (private.plan_client_editing / plan_staff_editing). The database
 * decides on every save; these shapes only describe what to show.
 *
 * Deadline: 00:00 in the event's time zone on the event date minus the plan's
 * days (the first moment of that day where DST skips or repeats midnight).
 * open: before it; reopened: after it, until a staff reopening ends; closed:
 * otherwise. Times are ISO instants; display them in the event's zone.
 */

/** Setting limits, mirrored from the database checks. */
export const CUTOFF_DAYS_MIN = 0;
export const CUTOFF_DAYS_MAX = 365;
export const REOPEN_MAX_DAYS = 14;
export const REASON_MAX = 500;

export const clientEditingSchema = z.object({
  state: z.enum(["open", "reopened", "closed"]),
  deadline: z.string(),
  /** When editing closes: the deadline, or the reopening's end. Null when closed. */
  closes_at: z.string().nullable(),
  timezone: z.string(),
});
export type ClientEditing = z.infer<typeof clientEditingSchema>;

const historySchema = z.object({
  action: z.string(),
  at: z.string(),
  actor: z.string(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type CutoffHistoryEntry = z.infer<typeof historySchema>;

export const staffEditingSchema = clientEditingSchema.extend({
  now: z.string(),
  cutoff_days: z.number().int(),
  business_days: z.number().int(),
  expected_deadline: z.string(),
  schedule_changed: z.boolean(),
  reopened_until: z.string().nullable(),
  reopen_active: z.boolean(),
  reopen_max_days: z.number().int(),
  version: z.number().int(),
  history: z.array(historySchema),
});
export type StaffEditing = z.infer<typeof staffEditingSchema>;

/** "Friday, October 16, 2026 at 12:00 a.m. EDT (America/Toronto)". */
export function formatInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const formatted = new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeStyle: "short", timeZone }).format(date);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
  return `${formatted}${zone ? ` ${zone}` : ""} (${timeZone})`;
}

/** The wall-clock "YYYY-MM-DDTHH:MM" of an instant in a time zone (for datetime-local inputs). */
export function localInputValue(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A datetime-local value ("YYYY-MM-DDTHH:MM", optional seconds), or null. */
export function parseLocalInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

/** Validates a staff reason the way the database does. */
export function checkReason(reason: string): string | null {
  if (reason.trim().length === 0) return "Enter a reason. It is kept in the history and never shown to the client.";
  if (reason.trim().length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  return null;
}

const ACTION_LABELS: Record<string, string> = {
  planning_cutoff_set: "Deadline set",
  planning_cutoff_changed: "Deadline changed",
  planning_cutoff_recalculated: "Deadline recalculated",
  planning_client_reopened: "Client editing reopened",
  planning_client_reopen_closed: "Client editing closed early",
};
export function historyLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** The client's one-line status. */
export function clientEditingText(e: ClientEditing, djName: string): string {
  if (e.state === "closed") return "Planning is read-only. Contact your DJ for changes.";
  if (e.state === "reopened") return `${djName} reopened planning for you. You can make changes until ${formatInstant(e.closes_at ?? e.deadline, e.timezone)}.`;
  return `You can make changes until ${formatInstant(e.closes_at ?? e.deadline, e.timezone)}. After that, planning becomes read-only; contact ${djName} for changes.`;
}
