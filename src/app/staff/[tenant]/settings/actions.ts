"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, ok, text, type ActionState } from "@/lib/forms";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Saves the legal business identity and deposit percentage. Owner only: the
 * page hides the form from staff, and update_business_settings checks the
 * owner role again in the database. Existing contracts keep what they froze.
 */
export async function saveBusinessSettings(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change business settings.");
  const legalName = text(form, "legal_name");
  const address = text(form, "business_address");
  const contactEmail = text(form, "contact_email").toLowerCase();
  const rawPercent = text(form, "deposit_percent");
  if (legalName.length < 1 || legalName.length > 200) return fail("Enter the legal business name (up to 200 characters).");
  if (address.length < 1 || address.length > 500) return fail("Enter the business address (up to 500 characters).");
  if (!EMAIL_RE.test(contactEmail) || contactEmail.length > 320) return fail("Enter a valid contact email.");
  // Whole numbers only: "50", not "50.5" or "50%".
  if (!/^\d{1,3}$/.test(rawPercent) || Number(rawPercent) > 100) return fail("The deposit must be a whole percentage from 0 to 100.");

  const { error } = await supabase.rpc("update_business_settings", {
    p_tenant_id: tenant.id,
    p_legal_name: legalName,
    p_business_address: address,
    p_contact_email: contactEmail,
    p_deposit_percent: Number(rawPercent),
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Settings saved. Existing contract drafts keep their details until you regenerate them.");
}
