"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff, type StaffContext } from "@/lib/auth/staff";
import { findClientWithEmail } from "@/lib/clients.server";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { readClientForm } from "../clients/client-form";
import { EVENT_DETAIL_COLUMNS, eventDetailsKey, readEventForm } from "./event-form";

/** An active client of this business that can be put on an event, or why not. */
async function usableClient(staff: StaffContext, clientId: string): Promise<string | null> {
  if (!UUID_RE.test(clientId)) return "Choose a client.";
  const { data } = await staff.supabase.from("clients").select("archived_at").eq("id", clientId).eq("tenant_id", staff.tenant.id).maybeSingle();
  if (!data) return "That client wasn't found. Search again and choose them from the list.";
  if (data.archived_at) return "That client is archived. Restore them on their client page, or choose another client.";
  return null;
}

export async function createEvent(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const parsed = readEventForm(form);
  if (!parsed.ok) return fail(parsed.error);
  // Set once, here; the database refuses any later change.
  const source = text(form, "booking_source") || "flux";
  if (source !== "flux" && source !== "external") return fail("Choose how this event is being booked.");

  // Primary contact: an existing client, or a new one entered on the form.
  let clientId = text(form, "client_id");
  if (clientId === "new") {
    const client = readClientForm(form);
    if (!client.ok) return fail(client.error);
    // The email is already on file: suggest choosing that client instead; never merged or reused silently.
    const existing = await findClientWithEmail(supabase, tenant.id, client.values.email);
    if (existing && !checkbox(form, "confirm_duplicate")) {
      return fail(
        `${existing.name}${existing.archived_at ? " (archived)" : ""} already uses ${client.values.email}. Choose them under “Existing client”, or confirm this is a different person.`,
        { confirm: { name: "confirm_duplicate", label: `Create a separate client with ${client.values.email} (nothing is merged).` } },
      );
    }
    const { data, error } = await supabase.from("clients").insert({ ...client.values, tenant_id: tenant.id }).select("id").single();
    if (error) return fail(describeDbError(error));
    clientId = data.id;
  } else if (!clientId) {
    return fail("Choose the primary contact, or switch to “New client” and enter their details.");
  } else {
    const problem = await usableClient(staff, clientId);
    if (problem) return fail(problem);
  }

  const { data: event, error } = await supabase.from("events").insert({ ...parsed.values, booking_source: source, tenant_id: tenant.id }).select("id").single();
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

/**
 * Saves the event's details. The form carries the details it was opened
 * with (event_original); if another save changed any of them since, nothing
 * is written. Status, booking and planning changes made meanwhile don't
 * count as conflicts. Proposals, approvals and contracts keep the details
 * frozen into them; only new contract drafts use the new ones.
 */
export async function updateEvent(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const parsed = readEventForm(form);
  if (!parsed.ok) return fail(parsed.error);
  const { data: current } = await supabase.from("events").select(`${EVENT_DETAIL_COLUMNS.join(", ")}, updated_at`).eq("id", eventId).eq("tenant_id", tenant.id).maybeSingle();
  if (!current) return fail("Event not found.");
  const original = text(form, "event_original");
  if (original && original !== eventDetailsKey(current as unknown as Record<string, unknown>)) {
    return fail("Someone else changed this event's details after you opened the form. Reload the page to see them, then make your change again.");
  }
  const { data, error } = await supabase
    .from("events")
    .update(parsed.values)
    .eq("id", eventId)
    .eq("tenant_id", tenant.id)
    .eq("updated_at", (current as unknown as { updated_at: string }).updated_at)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("This event changed while you were saving. Reload the page, then try again.");
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok("Saved.");
}

/**
 * Adds a contact through add_event_contact: one transaction under the event's
 * lock, so making someone primary contact and signer either fully happens or
 * leaves the previous primary and signer untouched. The form names the
 * primary contact the page showed; if it changed meanwhile, nothing is saved.
 */
export async function addEventContact(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const clientId = text(form, "client_id");
  const problem = await usableClient(staff, clientId);
  if (problem) return fail(problem);
  const primary = checkbox(form, "is_primary");
  const expected = text(form, "expected_primary_client_id");
  const { error } = await staff.supabase.rpc("add_event_contact", {
    p_event_id: eventId,
    p_client_id: clientId,
    p_make_primary: primary,
    p_make_signer: primary,
    p_expected_primary_client_id: UUID_RE.test(expected) ? expected : undefined,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  return ok("Contact added.");
}

/** Removes one contact of this event (remove_event_contact checks the row belongs to it). */
export async function removeEventContact(slug: string, eventId: string, eventClientId: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(eventId) || !UUID_RE.test(eventClientId)) return fail("Contact not found.");
  const { error } = await supabase.rpc("remove_event_contact", { p_event_id: eventId, p_event_client_id: eventClientId });
  if (error) {
    if (error.code === "23503") return fail("This contact has client access history and cannot be removed.");
    if (error.code === "P0002") return fail("This contact isn't on this event anymore. Reload the page.");
    return fail(describeDbError(error));
  }
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
  if (!archived) {
    const { data: event } = await supabase.from("events").select("booking_source").eq("id", eventId).maybeSingle();
    return ok(
      event?.booking_source === "external"
        ? "Event restored. A client who already had access can open planning again; send a new invitation if they hadn't accepted one."
        : "Event restored. Client links stay revoked; send a revised offer to give the client access again.",
    );
  }
  return ok(`Event archived.${result.links_revoked ? ` ${result.links_revoked} client link(s) revoked.` : ""}`);
}
