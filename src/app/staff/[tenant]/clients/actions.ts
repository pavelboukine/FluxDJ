"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { duplicateEmailWarning, emailChangeImpact, emailImpactText, findClientWithEmail, hasEmailImpact } from "@/lib/clients.server";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { containsFilter, SEARCH_MAX } from "@/lib/lists";
import { checkClientPhone } from "@/lib/phone";
import { readClientForm } from "./client-form";

const CONFLICT = "Someone else changed this client's details after you opened the form. Reload the page to see them, then make your change again.";

export async function createClientRecord(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readClientForm(form);
  if (!parsed.ok) return fail(parsed.error);
  // Same email already on file: suggest that client, or save after an explicit confirmation.
  const existing = await findClientWithEmail(supabase, tenant.id, parsed.values.email);
  if (existing && !checkbox(form, "confirm_duplicate")) {
    const w = duplicateEmailWarning(slug, parsed.values.email, existing);
    return fail(w.message, { link: w.link, confirm: w.confirm });
  }
  const { error } = await supabase.from("clients").insert({ ...parsed.values, tenant_id: tenant.id });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/clients`);
  return ok(`Added ${parsed.values.name}.`);
}

/**
 * Saves a client's contact details. The form carries the record's
 * updated_at, and the update only applies to that version, so two people
 * editing at once can't silently overwrite each other. Changing an email
 * that already has sign-ins, a sent contract or live proposal links needs an
 * explicit confirmation that explains what does and doesn't move. Nothing
 * already sent, signed or emailed is rewritten.
 */
export async function updateClientRecord(slug: string, clientId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(clientId)) return fail("Client not found.");
  const { data: current } = await supabase.from("clients").select("id, email, phone, updated_at").eq("id", clientId).eq("tenant_id", tenant.id).maybeSingle();
  if (!current) return fail("Client not found.");
  const expected = text(form, "client_updated_at");
  if (expected && expected !== current.updated_at) return fail(CONFLICT);
  const parsed = readClientForm(form, current.phone);
  if (!parsed.ok) return fail(parsed.error);

  if (parsed.values.email !== current.email.toLowerCase()) {
    const existing = await findClientWithEmail(supabase, tenant.id, parsed.values.email, clientId);
    if (existing && !checkbox(form, "confirm_duplicate")) {
      const w = duplicateEmailWarning(slug, parsed.values.email, existing);
      return fail(w.message, { link: w.link, confirm: w.confirm });
    }
    const impact = await emailChangeImpact(supabase, tenant.id, clientId);
    if (hasEmailImpact(impact) && !checkbox(form, "confirm_email_change")) {
      return fail(emailImpactText(impact, current.email), {
        confirm: { name: "confirm_email_change", label: `Change the email to ${parsed.values.email}; existing access stays as described.` },
      });
    }
  }

  // Archiving is its own confirmed action (setClientArchived); saving details never changes it.
  const { data, error } = await supabase
    .from("clients")
    .update(parsed.values)
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .eq("updated_at", current.updated_at)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail(CONFLICT);
  revalidatePath(`/staff/${slug}/clients`, "layout");
  revalidatePath(`/staff/${slug}/events`, "layout");
  return ok("Contact details saved.");
}

/**
 * Adds a phone number to a client that has none, from the contract step
 * (a template printing {{client.phone}} needs it). Only fills an empty
 * number, so it never overwrites one saved meanwhile; contracts already
 * generated keep the details they were generated with.
 */
export async function addClientPhone(slug: string, clientId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(clientId)) return fail("Client not found.");
  const checked = checkClientPhone(text(form, "client_phone"));
  if (!checked.ok) return fail(checked.message);
  if (!checked.value) return fail("Enter the phone number.");
  const { data, error } = await supabase
    .from("clients")
    .update({ phone: checked.value })
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .is("phone", null)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) {
    const { data: still } = await supabase.from("clients").select("phone").eq("id", clientId).eq("tenant_id", tenant.id).maybeSingle();
    if (!still) return fail("Client not found.");
    revalidatePath(`/staff/${slug}`, "layout");
    return fail("This client already has a phone number (it was saved elsewhere). Reload the page to see it.");
  }
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Phone number saved.");
}

export type ClientOption = { id: string; name: string; email: string; phone: string | null };

/** Up to 8 active clients of this business matching a name, email or phone search, for the client picker. */
export async function searchClients(slug: string, query: string): Promise<ClientOption[]> {
  const { supabase, tenant } = await requireStaff(slug);
  const q = query.trim().slice(0, SEARCH_MAX);
  let request = supabase.from("clients").select("id, name, email, phone").eq("tenant_id", tenant.id).is("archived_at", null).order("name").order("email").limit(8);
  if (q) request = request.or(containsFilter(["name", "email", "phone"], q));
  const { data } = await request;
  return data ?? [];
}

/**
 * Archives or restores a client through set_client_archived (staff of the
 * business; audited; a repeat is a no-op). Only the client's archived state
 * changes: events, contact links, documents and sign-ins are untouched.
 */
export async function setClientArchived(slug: string, clientId: string, archived: boolean): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(clientId)) return fail("Client not found.");
  const { data, error } = await supabase.rpc("set_client_archived", { p_client_id: clientId, p_archived: archived });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  const result = data as { replayed?: boolean };
  if (result.replayed) return ok(archived ? "This client was already archived." : "This client was already active.");
  return ok(archived ? "Client archived." : "Client restored.");
}
