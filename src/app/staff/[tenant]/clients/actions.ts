"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, ok, type ActionState } from "@/lib/forms";
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
  const archived = checkbox(form, "archived");
  const { data, error } = await supabase
    .from("clients")
    .update({ ...parsed.values, archived_at: archived ? new Date().toISOString() : null })
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Client not found.");
  revalidatePath(`/staff/${slug}/clients`);
  return ok("Saved.");
}
