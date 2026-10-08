"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";

function readDetails(form: FormData) {
  const name = text(form, "name");
  const expiryDays = int(form, "expiry_days", 1, 365);
  const intro = optionalText(form, "intro");
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Name is required (up to 200 characters)." } as const;
  if (expiryDays === null) return { ok: false, error: "Proposals must expire after 1 to 365 days." } as const;
  if (intro && intro.length > 10000) return { ok: false, error: "The intro is too long (up to 10,000 characters)." } as const;
  return { ok: true, values: { name, intro, expiry_days: expiryDays } } as const;
}

/**
 * The template's contents from the form: package_1..3 (presentation order,
 * empty slots skipped), default_package_id, question (in order), addon with
 * rec:<id> and max:<id>. The database checks the same rules again.
 */
function readContents(form: FormData) {
  const packageIds = [1, 2, 3].map((n) => text(form, `package_${n}`)).filter(Boolean);
  if (packageIds.some((id) => !UUID_RE.test(id))) return { ok: false, error: "Choose packages from the list." } as const;
  if (new Set(packageIds).size !== packageIds.length) return { ok: false, error: "Each package can appear once." } as const;
  const recommended = text(form, "default_package_id") || null;
  if (recommended && !packageIds.includes(recommended)) return { ok: false, error: "The recommended package must be one of the chosen packages." } as const;

  const addons: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[] = [];
  for (const gearId of form.getAll("addon").filter((v): v is string => typeof v === "string")) {
    if (!UUID_RE.test(gearId)) return { ok: false, error: "Choose extras from the list." } as const;
    if (addons.some((a) => a.gear_item_id === gearId)) return { ok: false, error: "Each extra can appear once." } as const;
    const max = int(form, `max:${gearId}`, 1, 100);
    const rec = int(form, `rec:${gearId}`, 0, 100);
    if (max === null || rec === null || rec > max) return { ok: false, error: "Extras: “Up to” must be 1 to 100, and “Preselected” from 0 to that maximum." } as const;
    addons.push({ gear_item_id: gearId, recommended_quantity: rec, max_quantity: max });
  }
  const questionIds = form.getAll("question").filter((v): v is string => typeof v === "string");
  if (questionIds.some((id) => !UUID_RE.test(id))) return { ok: false, error: "Choose questions from the list." } as const;
  if (new Set(questionIds).size !== questionIds.length) return { ok: false, error: "Each question can be asked once." } as const;
  return { ok: true, packageIds, recommended, addons, questionIds } as const;
}

const contentsMessage = (packages: number) =>
  packages === 3 ? "" : ` Proposals need three packages before they can be sent; this template has ${packages}.`;

/**
 * Creates a template with its contents in one step (create_proposal_template):
 * all or nothing, so a failure keeps the form as typed. The form's request
 * id makes a retry after a lost response return the template already
 * created instead of creating another.
 */
export async function createTemplate(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const requestId = text(form, "request_id");
  if (!UUID_RE.test(requestId)) return fail("Reload the page and try again.");
  const details = readDetails(form);
  if (!details.ok) return fail(details.error);
  const contents = readContents(form);
  if (!contents.ok) return fail(contents.error);
  const { data, error } = await supabase.rpc("create_proposal_template", {
    p_tenant_id: tenant.id,
    p_template_id: requestId,
    p_name: details.values.name,
    // Nullable in the database; the generated types mark them required.
    p_intro: details.values.intro as string,
    p_expiry_days: details.values.expiry_days,
    p_package_ids: contents.packageIds,
    p_default_package_id: contents.recommended as string,
    p_addons: contents.addons,
    p_question_ids: contents.questionIds,
  });
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  const result = data as { id: string; replayed: boolean };
  revalidatePath(`/staff/${slug}/templates`);
  redirect(`/staff/${slug}/templates/${result.id}?created=${result.replayed ? "replayed" : "1"}`);
}

export async function updateTemplate(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readDetails(form);
  if (!parsed.ok) return fail(parsed.error);
  // Archiving is its own confirmed action (setTemplateArchived); saving details never changes it.
  const { data, error } = await supabase
    .from("proposal_templates")
    .update(parsed.values)
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}/templates`, "layout");
  return ok("Details saved.");
}

/** Replaces the template's packages, recommendation, extras and questions in one call (set_proposal_template_composition). */
export async function saveTemplateComposition(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(templateId)) return fail("Template not found.");
  const contents = readContents(form);
  if (!contents.ok) return fail(contents.error);
  const { error } = await supabase.rpc("set_proposal_template_composition", {
    p_template_id: templateId,
    p_package_ids: contents.packageIds,
    // The SQL parameter accepts null (no recommended package yet); the generated type marks it required.
    p_default_package_id: contents.recommended as string,
    p_addons: contents.addons,
    p_question_ids: contents.questionIds,
  });
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  revalidatePath(`/staff/${slug}/templates`, "layout");
  return ok(`Contents saved.${contentsMessage(contents.packageIds.length)}`);
}

/**
 * Archives (hides from "Start from template") or restores a template. Its
 * contents are kept; proposal drafts already made from it are unaffected.
 */
export async function setTemplateArchived(slug: string, templateId: string, archived: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(templateId)) return fail("Template not found.");
  const { data, error } = await supabase.from("proposal_templates").update({ active: !archived }).eq("id", templateId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(archived ? "Template archived." : "Template restored.");
}
