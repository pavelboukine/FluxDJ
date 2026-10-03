"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Saves the event's single editable draft in place. Never freezes or sends:
 * the offer snapshot is created only by the send flow (step 6).
 * expectedVersion guards against another tab overwriting newer edits.
 */
export async function saveDraft(slug: string, proposalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const expectedVersion = int(form, "draft_version", 0, 2_000_000_000);
  if (expectedVersion === null) return fail("Reload the page and try again.");
  const { data: current } = await supabase.from("proposals").select("draft_offer").eq("id", proposalId).maybeSingle();
  if (!current) return fail("Proposal not found.");

  const expiryDays = int(form, "expiry_days", 1, 365);
  if (expiryDays === null) return fail("Expiry must be 1 to 365 days.");
  const intro = optionalText(form, "intro");
  if (intro && intro.length > 10000) return fail("Intro is too long.");

  const popular = text(form, "popular");
  const packages: { package_id: string; is_popular: boolean }[] = [];
  for (const n of ["1", "2", "3"]) {
    const id = text(form, `package_${n}`);
    if (!id) continue;
    if (!UUID_RE.test(id)) return fail("Choose packages from the list.");
    packages.push({ package_id: id, is_popular: popular === n });
  }

  const addons: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[] = [];
  for (const gearId of form.getAll("addon").filter((v): v is string => typeof v === "string")) {
    if (!UUID_RE.test(gearId)) return fail("Invalid addon.");
    const max = int(form, `max:${gearId}`, 1, 100);
    const rec = int(form, `rec:${gearId}`, 0, 100);
    if (max === null || rec === null || rec > max) return fail("Addons: preselected quantity must be between 0 and the maximum (1 to 100).");
    addons.push({ gear_item_id: gearId, recommended_quantity: rec, max_quantity: max });
  }
  const questionIds = form.getAll("question").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));

  const previous = (current.draft_offer ?? {}) as { template_id?: string | null };
  const draft: Json = {
    template_id: previous.template_id ?? null,
    intro,
    expiry_days: expiryDays,
    packages,
    addons,
    question_ids: questionIds,
  };
  const { data: version, error } = await supabase.rpc("update_proposal_draft", { p_proposal_id: proposalId, p_expected_version: expectedVersion, p_offer: draft });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  return ok("Draft saved. Nothing has been sent.", version);
}

/** Replaces the draft's contents with a template's (packages, addons, questions, intro, expiry). */
export async function applyTemplate(slug: string, proposalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const expectedVersion = int(form, "draft_version", 0, 2_000_000_000);
  if (expectedVersion === null) return fail("Reload the page and try again.");
  const templateId = text(form, "template_id");
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  const { data: input, error: templateError } = await supabase.rpc("proposal_offer_input_from_template", { p_template_id: templateId });
  if (templateError || !input) return fail("Template not found.");
  const { data: version, error } = await supabase.rpc("update_proposal_draft", { p_proposal_id: proposalId, p_expected_version: expectedVersion, p_offer: input });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  return ok("Template applied.", version);
}
