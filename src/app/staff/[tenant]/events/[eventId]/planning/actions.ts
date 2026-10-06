"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { checkReason, CUTOFF_DAYS_MAX, CUTOFF_DAYS_MIN, formatInstant, parseLocalInput, REOPEN_MAX_DAYS, staffEditingSchema } from "@/lib/planning/cutoff";
import { saveResultSchema, type SaveItemResult } from "@/lib/planning/view";

/*
 * Staff planning for one event. The database checks membership of the
 * event's business, that the event isn't archived, and the plan's structure
 * version (stale tabs get a conflict). None of this touches the proposal,
 * contract, payments or booking.
 */

const planningPath = (slug: string, eventId: string) => `/staff/${slug}/events/${eventId}/planning`;

function revalidate(slug: string, eventId: string) {
  revalidatePath(planningPath(slug, eventId));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
}

export async function setUpPlanning(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const templateId = text(form, "template_id");
  if (templateId && !UUID_RE.test(templateId)) return fail("Choose a template from the list.");
  const { data, error } = await supabase.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: (templateId || null) as string });
  if (error) return fail(describeDbError(error));
  revalidate(slug, eventId);
  return ok((data as { status: string }).status === "exists" ? "Planning was already set up." : "Planning is set up.");
}

export async function applyPlanningTemplate(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const templateId = text(form, "template_id");
  const version = int(form, "draft_version", 1, 1_000_000);
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  if (version === null) return fail("Reload the page and try again.");
  if (!checkbox(form, "confirm")) return fail("Check the box to confirm replacing the structure.");
  const { data, error } = await supabase.rpc("apply_event_plan_template", {
    p_event_id: eventId,
    p_template_id: templateId,
    p_expected_version: version,
    p_confirm: true,
  });
  if (error) return fail(describeDbError(error));
  const r = data as { structure_version: number; kept: number; added: number; hidden: number };
  revalidate(slug, eventId);
  return ok(`Template applied: ${r.kept} kept, ${r.added} added, ${r.hidden} hidden. No answers were removed.`, r.structure_version);
}

/** Rename, move, hide or restore one item: fields op, item_id, label, draft_version. */
export async function planItemAction(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const op = text(form, "op");
  const itemId = text(form, "item_id");
  const version = int(form, "draft_version", 1, 1_000_000);
  if (!UUID_RE.test(itemId) || version === null) return fail("Reload the page and try again.");
  const result =
    op === "rename"
      ? await supabase.rpc("rename_event_plan_item", { p_item_id: itemId, p_expected_version: version, p_label: text(form, "label") })
      : op === "up" || op === "down"
        ? await supabase.rpc("move_event_plan_item", { p_item_id: itemId, p_expected_version: version, p_direction: op })
        : op === "hide" || op === "restore"
          ? await supabase.rpc("set_event_plan_item_enabled", { p_item_id: itemId, p_expected_version: version, p_enabled: op === "restore" })
          : null;
  if (!result) return fail("Reload the page and try again.");
  if (result.error) return fail(describeDbError(result.error));
  revalidate(slug, eventId);
  return ok("Saved.", result.data as number);
}

/** Adds a library item (or restores it): field item = "key" or "key|parent_key". */
export async function addPlanItem(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const [key, parentKey] = text(form, "item").split("|");
  const version = int(form, "draft_version", 1, 1_000_000);
  if (!key || version === null) return fail("Choose an item to add.");
  const { data, error } = await supabase.rpc("add_event_plan_item", {
    p_event_id: eventId,
    p_expected_version: version,
    p_key: key,
    p_parent_key: (parentKey ?? null) as string,
  });
  if (error) return fail(describeDbError(error));
  revalidate(slug, eventId);
  return ok("Added.", data as number);
}

export async function saveStaffItemAction(slug: string, eventId: string, itemId: string, expectedRevision: number, answers: unknown): Promise<SaveItemResult> {
  if (typeof slug !== "string" || typeof eventId !== "string" || !UUID_RE.test(eventId) || typeof itemId !== "string" || !UUID_RE.test(itemId) ||
      !Number.isInteger(expectedRevision) || typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return { status: "invalid", field: null, message: "Reload the page and try again." };
  }
  const { supabase } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("staff_save_plan_item", {
    p_event_id: eventId,
    p_item_id: itemId,
    p_expected_revision: expectedRevision,
    p_answers: JSON.parse(JSON.stringify(answers)),
  });
  if (error) return { status: "error", message: describeDbError(error) };
  const parsed = saveResultSchema.safeParse(data);
  return parsed.success ? parsed.data : { status: "error", message: "Couldn't save. Reload the page and try again." };
}

/*
 * Client editing deadline and temporary reopening. The database checks
 * membership, archiving, the cutoff version (a stale tab gets a conflict),
 * the reason and the limits again, using its own clock, and audits each
 * change. Staff editing is never affected.
 */

type CutoffResult = { status: string; version: number; editing: unknown };

function cutoffOutcome(slug: string, eventId: string, data: unknown) {
  const r = data as CutoffResult;
  const editing = staffEditingSchema.safeParse(r?.editing);
  revalidate(slug, eventId);
  return { status: r?.status, version: r?.version, editing: editing.success ? editing.data : null };
}

/** Sets this plan's days before the event (recomputed from the current date and time zone). */
export async function setClientCutoffDays(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const version = int(form, "draft_version", 1, 1_000_000);
  const days = int(form, "days", CUTOFF_DAYS_MIN, CUTOFF_DAYS_MAX);
  const reason = text(form, "reason");
  if (version === null) return fail("Reload the page and try again.");
  if (days === null) return fail(`Enter a whole number of days from ${CUTOFF_DAYS_MIN} to ${CUTOFF_DAYS_MAX}.`);
  const reasonError = checkReason(reason);
  if (reasonError) return fail(reasonError);
  const { data, error } = await supabase.rpc("set_plan_client_cutoff", { p_event_id: eventId, p_expected_version: version, p_days: days, p_reason: reason });
  if (error) return fail(describeDbError(error));
  const r = cutoffOutcome(slug, eventId, data);
  const when = r.editing ? formatInstant(r.editing.deadline, r.editing.timezone) : "";
  if (r.status === "unchanged") return ok(`No change: the deadline already is ${when}.`, r.version);
  return ok(`Deadline changed to ${when}.${r.editing?.state === "closed" ? " It has passed: the client's planning is read-only." : ""}`, r.version);
}

/** Moves the deadline to match the event's current date and time zone, with the plan's days. */
export async function recalculateClientCutoff(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const version = int(form, "draft_version", 1, 1_000_000);
  const reason = text(form, "reason");
  if (version === null) return fail("Reload the page and try again.");
  if (!checkbox(form, "confirm")) return fail("Check the box to confirm moving the deadline.");
  const reasonError = checkReason(reason);
  if (reasonError) return fail(reasonError);
  const { data, error } = await supabase.rpc("recalculate_plan_client_cutoff", { p_event_id: eventId, p_expected_version: version, p_reason: reason, p_confirm: true });
  if (error) return fail(describeDbError(error));
  const r = cutoffOutcome(slug, eventId, data);
  const when = r.editing ? formatInstant(r.editing.deadline, r.editing.timezone) : "";
  if (r.status === "unchanged") return ok(`No change: the deadline already matches the event (${when}).`, r.version);
  return ok(`Deadline recalculated: ${when}.${r.editing?.state === "closed" ? " It has passed: the client's planning is read-only." : ""}`, r.version);
}

/** Reopens client editing until a time in the event's time zone (after the deadline only). */
export async function reopenClientEditing(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const version = int(form, "draft_version", 1, 1_000_000);
  const until = parseLocalInput(text(form, "until"));
  const reason = text(form, "reason");
  if (version === null) return fail("Reload the page and try again.");
  if (!until) return fail("Choose the date and time the reopening ends.");
  const reasonError = checkReason(reason);
  if (reasonError) return fail(reasonError);
  const { data, error } = await supabase.rpc("reopen_plan_client_editing", { p_event_id: eventId, p_expected_version: version, p_until_local: until, p_reason: reason });
  if (error) return fail(describeDbError(error));
  const r = cutoffOutcome(slug, eventId, data);
  const e = r.editing;
  if (r.status === "already_open") {
    return fail(`Client editing is already open until ${e ? formatInstant(e.deadline, e.timezone) : "the deadline"}. Nothing was changed; reopening is for after the deadline.`);
  }
  const until_ = e?.reopened_until ? formatInstant(e.reopened_until, e.timezone) : "";
  if (r.status === "unchanged") return ok(`Client editing is already reopened until ${until_}.`, r.version);
  return ok(`Client editing reopened until ${until_} (at most ${REOPEN_MAX_DAYS} days). The normal deadline is unchanged.`, r.version);
}

/** Ends an active reopening now. */
export async function closeClientEditing(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const version = int(form, "draft_version", 1, 1_000_000);
  const reason = text(form, "reason");
  if (version === null) return fail("Reload the page and try again.");
  const reasonError = checkReason(reason);
  if (reasonError) return fail(reasonError);
  const { data, error } = await supabase.rpc("close_plan_client_editing", { p_event_id: eventId, p_expected_version: version, p_reason: reason });
  if (error) return fail(describeDbError(error));
  const r = cutoffOutcome(slug, eventId, data);
  const e = r.editing;
  if (r.status === "already_open") {
    return fail(`Client editing is open until the normal deadline (${e ? formatInstant(e.deadline, e.timezone) : ""}). Ending a reopening doesn't close it; change the deadline instead.`);
  }
  if (r.status === "not_reopened") return ok("There is no active reopening: the client's planning is already read-only.", r.version);
  return ok("Client editing closed. The client can still read the plan, and you can still edit it.", r.version);
}
