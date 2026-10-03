"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";

function readDetails(form: FormData) {
  const name = text(form, "name");
  const expiryDays = int(form, "expiry_days", 1, 365);
  const intro = optionalText(form, "intro");
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Name is required (up to 200 characters)." } as const;
  if (expiryDays === null) return { ok: false, error: "Expiry must be 1 to 365 days." } as const;
  if (intro && intro.length > 10000) return { ok: false, error: "Intro is too long." } as const;
  return { ok: true, values: { name, intro, expiry_days: expiryDays } } as const;
}

export async function createTemplate(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readDetails(form);
  if (!parsed.ok) return fail(parsed.error);
  const { data, error } = await supabase
    .from("proposal_templates")
    .insert({ ...parsed.values, tenant_id: tenant.id })
    .select("id")
    .single();
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/templates`);
  redirect(`/staff/${slug}/templates/${data.id}`);
}

export async function updateTemplate(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readDetails(form);
  if (!parsed.ok) return fail(parsed.error);
  const { data, error } = await supabase
    .from("proposal_templates")
    .update({ ...parsed.values, active: checkbox(form, "active") })
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}/templates`);
  return ok("Saved.");
}

export async function saveTemplateComposition(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);

  const packageIds = [1, 2, 3].map((n) => text(form, `package_${n}`)).filter(Boolean);
  if (packageIds.some((id) => !UUID_RE.test(id))) return fail("Choose packages from the list.");
  if (new Set(packageIds).size !== packageIds.length) return fail("Each package can appear once.");
  const recommended = text(form, "default_package_id") || null;
  if (recommended && !packageIds.includes(recommended)) return fail("The recommended package must be one of the chosen packages.");

  const addons: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[] = [];
  for (const gearId of form.getAll("addon").filter((v): v is string => typeof v === "string")) {
    if (!UUID_RE.test(gearId)) return fail("Invalid addon.");
    const max = int(form, `max:${gearId}`, 1, 100);
    const rec = int(form, `rec:${gearId}`, 0, 100);
    if (max === null || rec === null || rec > max) return fail("Addon quantities: recommended must be between 0 and the maximum (1 to 100).");
    addons.push({ gear_item_id: gearId, recommended_quantity: rec, max_quantity: max });
  }
  const questionIds = form.getAll("question").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));

  const { error } = await supabase.rpc("set_proposal_template_composition", {
    p_template_id: templateId,
    p_package_ids: packageIds,
    // The SQL parameter accepts null (no recommended package yet); the generated type marks it required.
    p_default_package_id: recommended as string,
    p_addons: addons,
    p_question_ids: questionIds,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/templates/${templateId}`);
  return ok(packageIds.length === 3 ? "Template saved." : "Saved. Proposals need exactly three packages before they can be sent.");
}
