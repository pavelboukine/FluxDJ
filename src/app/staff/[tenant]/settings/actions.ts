"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, ok, text, type ActionState } from "@/lib/forms";
import { normalizeHex } from "@/lib/branding/colors";
import { processLogo, storeLogo } from "@/lib/branding/logo.server";
import { allowRequest } from "@/lib/rate-limit.server";
import { CUTOFF_DAYS_MAX, CUTOFF_DAYS_MIN } from "@/lib/planning/cutoff";
import { parseTaxSettingsForm } from "@/lib/pricing/tax-settings";

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

/**
 * Chooses when bookings are confirmed. Owner only (checked again in the
 * database), versioned against stale tabs. Each contract freezes the policy
 * when it is generated, so only contracts generated afterwards follow it.
 */
export async function saveBookingPolicy(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change the booking policy.");
  const policy = text(form, "booking_policy");
  if (policy !== "on_deposit" && policy !== "on_signature") return fail("Choose when bookings are confirmed.");
  const expected = Number(text(form, "draft_version"));
  if (!Number.isInteger(expected) || expected < 0) return fail("Reload the page and try again.");
  const { data: version, error } = await supabase.rpc("update_booking_policy", { p_tenant_id: tenant.id, p_policy: policy, p_expected_version: expected });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Booking policy saved. It applies to contracts generated from now on.", version);
}

/**
 * Replaces the tax list and the category mapping together. Owner only: the
 * page shows staff a read-only view, and update_tax_settings checks the owner
 * role, the settings version and every rule again in the database. Only new
 * offers read these settings; sent offers and contracts keep their snapshots.
 */
export async function saveTaxSettings(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change tax settings.");
  const expectedVersion = Number(text(form, "draft_version"));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return fail("Reload the page and try again.");
  const parsed = parseTaxSettingsForm(form);
  if (!parsed.ok) return fail(parsed.message);

  const { data: version, error } = await supabase.rpc("update_tax_settings", {
    p_tenant_id: tenant.id,
    p_expected_version: expectedVersion,
    p_tax_config: parsed.config,
    p_tax_categories: parsed.categories,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Tax settings saved. They apply to offers sent from now on; sent proposals and contracts keep their taxes.", version);
}

/**
 * How many calendar days before the event client planning closes (00:00 in
 * the event's time zone). Owner only (checked again in the database),
 * versioned against stale tabs. Plans keep the days they were set up with,
 * so only plans set up afterwards follow the change.
 */
export async function savePlanningCutoff(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change the planning deadline.");
  const raw = text(form, "planning_lock_days");
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < CUTOFF_DAYS_MIN || Number(raw) > CUTOFF_DAYS_MAX) {
    return fail(`Enter a whole number of days from ${CUTOFF_DAYS_MIN} to ${CUTOFF_DAYS_MAX}.`);
  }
  const expected = Number(text(form, "draft_version"));
  if (!Number.isInteger(expected) || expected < 0) return fail("Reload the page and try again.");
  const { data: version, error } = await supabase.rpc("update_planning_cutoff_days", { p_tenant_id: tenant.id, p_days: Number(raw), p_expected_version: expected });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Planning deadline saved. It applies to plans set up from now on; existing plans keep their deadlines.", version);
}

/**
 * Saves branding: an optional new logo (verified, re-encoded and registered
 * first), logo removal, and the primary colour, all checked against the
 * branding version so a stale tab can't overwrite newer branding. Owner only;
 * the database checks again. Any failure leaves the current logo active.
 */
export async function saveBranding(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, user, tenant, membership } = await requireStaff(slug);
  if (membership.role !== "owner") return fail("Only the owner can change branding.");
  const version = int(form, "draft_version", 0, 2_000_000_000);
  if (version === null) return fail("Reload the page and try again.");
  const rawColor = text(form, "primary_color");
  const color = rawColor === "" ? null : normalizeHex(rawColor);
  if (rawColor !== "" && !color) return fail("Enter the colour as a hex value like #1a2b3c.");

  const file = form.get("logo");
  let logoId: string | null;
  if (file instanceof File && file.size > 0) {
    if (!(await allowRequest("logo_upload", user.id, 20, 3600))) return fail("Too many logo uploads. Try again in an hour.");
    const processed = await processLogo(Buffer.from(await file.arrayBuffer()));
    if (!processed.ok) return fail(`${processed.message} Your current logo is unchanged.`);
    const stored = await storeLogo(tenant.id, user.id, processed.logo);
    if (!stored.ok) return fail(`${stored.error ? describeDbError(stored.error) : "The logo couldn't be stored."} Your current logo is unchanged.`);
    logoId = stored.stored.logoId;
  } else if (checkbox(form, "remove_logo")) {
    logoId = null;
  } else {
    // Keep the active logo (if any).
    const { data: current } = await supabase.from("tenants").select("logo_storage_path").eq("id", tenant.id).single();
    const { data: logo } = current?.logo_storage_path
      ? await supabase.from("tenant_logos").select("id").eq("tenant_id", tenant.id).eq("storage_path", current.logo_storage_path).maybeSingle()
      : { data: null };
    logoId = logo?.id ?? null;
  }

  const { data: newVersion, error } = await supabase.rpc("update_tenant_branding", {
    p_tenant_id: tenant.id,
    p_expected_version: version,
    p_logo_id: logoId as string,
    p_primary_color: color as string,
  });
  if (error) return fail(`${describeDbError(error)} Your current branding is unchanged.`);
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Branding saved. Proposals already sent keep the branding they were sent with.", newVersion ?? undefined);
}
