"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { readClientForm } from "../clients/client-form";
import { readEventForm } from "./event-form";

export async function createEvent(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readEventForm(form);
  if (!parsed.ok) return fail(parsed.error);

  // Primary contact: an existing client, or a new one entered on the form.
  let clientId = text(form, "client_id");
  if (clientId === "new") {
    const client = readClientForm(form);
    if (!client.ok) return fail(client.error);
    const { data, error } = await supabase.from("clients").insert({ ...client.values, tenant_id: tenant.id }).select("id").single();
    if (error) return fail(describeDbError(error));
    clientId = data.id;
  } else if (!UUID_RE.test(clientId)) {
    return fail("Choose the primary contact or add a new client.");
  }

  const { data: event, error } = await supabase.from("events").insert({ ...parsed.values, tenant_id: tenant.id }).select("id").single();
  if (error) return fail(describeDbError(error));
  const { error: contactError } = await supabase
    .from("event_clients")
    .insert({ tenant_id: tenant.id, event_id: event.id, client_id: clientId, is_primary: true, can_sign: true });
  revalidatePath(`/staff/${slug}/events`);
  if (contactError) {
    // The event exists; send staff there to attach the contact.
    redirect(`/staff/${slug}/events/${event.id}?contact=failed`);
  }
  redirect(`/staff/${slug}/events/${event.id}`);
}

export async function updateEvent(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readEventForm(form);
  if (!parsed.ok) return fail(parsed.error);
  const { data, error } = await supabase.from("events").update(parsed.values).eq("id", eventId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Event not found.");
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok("Saved.");
}

export async function addEventContact(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const clientId = text(form, "client_id");
  if (!UUID_RE.test(clientId)) return fail("Choose a client.");
  const primary = checkbox(form, "is_primary");
  if (primary) {
    const { error } = await supabase.from("event_clients").update({ is_primary: false, can_sign: false }).eq("event_id", eventId).eq("tenant_id", tenant.id);
    if (error) return fail(describeDbError(error));
  }
  const { error } = await supabase
    .from("event_clients")
    .insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: primary, can_sign: primary });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok("Contact added.");
}

export async function removeEventContact(slug: string, eventId: string, eventClientId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { error } = await supabase.from("event_clients").delete().eq("id", eventClientId).eq("tenant_id", tenant.id);
  if (error) return fail(error.code === "23503" ? "This contact has client access history and cannot be removed." : describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok("Contact removed.");
}

/** Opens the event's single proposal draft (prefilled from a template), or returns to the existing one. */
export async function openProposalDraft(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const templateId = text(form, "template_id");
  let offer = null;
  if (templateId) {
    if (!UUID_RE.test(templateId)) return fail("Choose a template.");
    const { data, error } = await supabase.rpc("proposal_offer_input_from_template", { p_template_id: templateId });
    if (error || !data) return fail("Template not found.");
    offer = data;
  }
  const { data: proposalId, error } = await supabase.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: offer ?? undefined });
  if (error) return fail(describeDbError(error));
  redirect(`/staff/${slug}/proposals/${proposalId}`);
}

/**
 * Archives or restores an event. Archiving revokes the event's client links
 * and sessions in the same transaction and blocks sends, approvals and
 * contract generation; nothing is deleted and the lifecycle status is kept.
 */
export async function setEventArchived(slug: string, eventId: string, archived: boolean): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const { data, error } = await supabase.rpc("set_event_archived", { p_event_id: eventId, p_archived: archived });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  const result = data as { links_revoked?: number };
  if (!archived) return ok("Event restored. Client links stay revoked; send a revised offer to give the client access again.");
  return ok(`Event archived.${result.links_revoked ? ` ${result.links_revoked} client link(s) revoked.` : ""}`);
}
