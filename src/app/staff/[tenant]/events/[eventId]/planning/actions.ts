"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { saveResultSchema, type SaveBasicsResult } from "@/lib/planning/view";

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

export async function saveStaffBasicsAction(slug: string, eventId: string, expectedRevision: number, answers: unknown): Promise<SaveBasicsResult> {
  if (typeof slug !== "string" || typeof eventId !== "string" || !UUID_RE.test(eventId) || !Number.isInteger(expectedRevision) ||
      typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return { status: "invalid", field: null, message: "Reload the page and try again." };
  }
  const { supabase } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("staff_save_plan_basics", {
    p_event_id: eventId,
    p_expected_revision: expectedRevision,
    p_answers: JSON.parse(JSON.stringify(answers)),
  });
  if (error) return { status: "error", message: describeDbError(error) };
  const parsed = saveResultSchema.safeParse(data);
  if (!parsed.success) return { status: "error", message: "Couldn't save. Reload the page and try again." };
  return parsed.data;
}
