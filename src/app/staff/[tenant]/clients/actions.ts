"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, ok, UUID_RE, type ActionState } from "@/lib/forms";
import { readClientForm } from "./client-form";

export async function createClientRecord(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readClientForm(form);
  if (!parsed.ok) return fail(parsed.error);
  const { error } = await supabase.from("clients").insert({ ...parsed.values, tenant_id: tenant.id });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/clients`);
  return ok(`Added ${parsed.values.name}.`);
}

export async function updateClientRecord(slug: string, clientId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readClientForm(form);
  if (!parsed.ok) return fail(parsed.error);
  // Archiving is its own confirmed action (setClientArchived); saving details never changes it.
  const { data, error } = await supabase
    .from("clients")
    .update(parsed.values)
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Client not found.");
  revalidatePath(`/staff/${slug}/clients`, "layout");
  return ok("Contact details saved.");
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
