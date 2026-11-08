"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, ok, text, type ActionState } from "@/lib/forms";
import { isSetupGuidance, type SetupGuidance } from "@/lib/setup";

const SAVED: Record<SetupGuidance, string> = {
  proposals_and_contracts: "Saved. Setup reminders now cover proposals and contracts.",
  contracts_only: "Saved. Setup reminders now cover contracts only.",
  none: "Saved. Your dashboard won't show setup reminders.",
};

/**
 * Which workflows setup reminders cover. Owner only: the page shows staff the
 * choice read-only, and update_setup_guidance checks the owner role again in the
 * database. Guidance only: no feature, event or other setting changes.
 */
export async function saveSetupGuidance(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change the setup guidance.");
  const guidance = text(form, "setup_guidance");
  if (!isSetupGuidance(guidance)) return fail("Choose your setup guidance.");
  const { error } = await supabase.rpc("update_setup_guidance", { p_tenant_id: tenant.id, p_guidance: guidance });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(SAVED[guidance]);
}
