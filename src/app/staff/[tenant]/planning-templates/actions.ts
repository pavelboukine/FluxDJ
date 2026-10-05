"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";

/*
 * Planning templates. Every change goes through a database function that
 * checks membership of the template's business and, for edits, the
 * template's version (a stale tab gets a conflict).
 */

const listPath = (slug: string) => `/staff/${slug}/planning-templates`;
const templatePath = (slug: string, id: string) => `/staff/${slug}/planning-templates/${id}`;

export async function installStarterTemplates(slug: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id });
  if (error) return fail(describeDbError(error));
  const result = data as { created: string[]; existing: string[] };
  revalidatePath(listPath(slug));
  const names = (keys: string[]) => keys.map((k) => (k === "wedding" ? "Wedding" : "Simple Party")).join(" and ");
  if (result.created.length === 0) return ok("The starter templates are already here (archived ones stay archived).");
  return ok(`Added ${names(result.created)}.`);
}

export async function createPlanningTemplate(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("create_planning_template", {
    p_tenant_id: tenant.id,
    p_name: text(form, "name"),
    p_description: optionalText(form, "description") as string,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(listPath(slug));
  redirect(templatePath(slug, data as string));
}

export async function updatePlanningTemplate(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const version = int(form, "draft_version", 1, 1_000_000);
  if (version === null) return fail("Reload the page and try again.");
  const { data, error } = await supabase.rpc("update_planning_template", {
    p_template_id: templateId,
    p_expected_version: version,
    p_name: text(form, "name"),
    p_description: optionalText(form, "description") as string,
    p_default_event_type: optionalText(form, "default_event_type") as string,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(templatePath(slug, templateId));
  revalidatePath(listPath(slug));
  return ok("Saved.", data as number);
}

export async function duplicatePlanningTemplate(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("duplicate_planning_template", { p_template_id: templateId, p_name: text(form, "name") });
  if (error) return fail(describeDbError(error));
  revalidatePath(listPath(slug));
  redirect(templatePath(slug, data as string));
}

export async function setPlanningTemplateArchived(slug: string, templateId: string, archived: boolean): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("set_planning_template_archived", { p_template_id: templateId, p_archived: archived });
  if (error) return fail(describeDbError(error));
  revalidatePath(templatePath(slug, templateId));
  revalidatePath(listPath(slug));
  return ok(archived ? "Archived. Plans already copied from it are not affected." : "Unarchived.", data as number);
}

/** Rename, move or remove one item: fields op, item_id, label, draft_version. */
export async function templateItemAction(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const op = text(form, "op");
  const itemId = text(form, "item_id");
  const version = int(form, "draft_version", 1, 1_000_000);
  if (!UUID_RE.test(itemId) || version === null) return fail("Reload the page and try again.");
  const result =
    op === "rename"
      ? await supabase.rpc("rename_planning_template_item", { p_item_id: itemId, p_expected_version: version, p_label: text(form, "label") })
      : op === "up" || op === "down"
        ? await supabase.rpc("move_planning_template_item", { p_item_id: itemId, p_expected_version: version, p_direction: op })
        : op === "remove"
          ? await supabase.rpc("remove_planning_template_item", { p_item_id: itemId, p_expected_version: version })
          : null;
  if (!result) return fail("Reload the page and try again.");
  if (result.error) return fail(describeDbError(result.error));
  revalidatePath(templatePath(slug, templateId));
  return ok(op === "rename" ? "Renamed." : op === "remove" ? "Removed." : "Moved.", result.data as number);
}

/** Adds a library item: field item = "key" or "key|parent_key". */
export async function addTemplateItem(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const [key, parentKey] = text(form, "item").split("|");
  const version = int(form, "draft_version", 1, 1_000_000);
  if (!key || version === null) return fail("Choose an item to add.");
  const { data, error } = await supabase.rpc("add_planning_template_item", {
    p_template_id: templateId,
    p_expected_version: version,
    p_key: key,
    p_parent_key: (parentKey ?? null) as string,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(templatePath(slug, templateId));
  return ok("Added.", data as number);
}
