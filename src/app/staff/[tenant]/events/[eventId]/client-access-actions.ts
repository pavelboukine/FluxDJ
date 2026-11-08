"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { planningInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";

/**
 * Invites the event's primary contact to plan it online (a Flux booking or
 * an event booked elsewhere). send_planning_invitation checks staff, that the
 * event is booked for planning, planning setup, open client editing, the
 * contact and archiving again in the database, and replaces any open
 * invitation. The first invitation also opens planning to the client, in the
 * same transaction ("Open planning & send invitation"). The form's request id
 * is the invitation id, so a retried submission is a replay with no second
 * email. Nothing else sends it.
 */
export async function sendPlanningInvitation(slug: string, eventId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const invitationId = text(form, "request_id");
  if (!UUID_RE.test(invitationId)) return fail("Reload the page and try again.");
  const { data, error } = await supabase.rpc("send_planning_invitation", {
    p_event_id: eventId,
    p_invitation_id: invitationId,
    p_token_hash: sha256Hex(planningInviteToken(invitationId)),
  });
  if (error) return fail(describeDbError(error));
  const result = data as { recipient_email?: string; opened?: boolean };
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  revalidatePath(`/staff/${slug}/events/${eventId}/planning`);
  // Queued, not yet sent: the card shows its delivery once the outbox has run.
  const recipient = result.recipient_email ?? "the client";
  return ok(
    result.opened
      ? `Planning is open to your client. The invitation to ${recipient} is queued; its delivery status appears under Client access.`
      : `Planning invitation queued for ${recipient}. Its delivery status appears under Client access.`,
  );
}

/**
 * Opens planning to the client without emailing anyone ("Open without
 * emailing"). open_client_planning checks staff, that the event is booked
 * for planning, set up and not archived; it is one-way and safe to repeat,
 * and it never changes the deadline or client editing.
 */
export async function openClientPlanning(slug: string, eventId: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const { data, error } = await supabase.rpc("open_client_planning", { p_event_id: eventId });
  if (error) return fail(describeDbError(error));
  const result = data as { status?: string; editing?: string };
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  revalidatePath(`/staff/${slug}/events/${eventId}/planning`);
  if (result.status === "already_open") return ok("Planning was already open to your client.");
  return ok(
    result.editing === "closed"
      ? "Planning is open to your client, read-only: client editing is closed. Nothing was emailed."
      : "Planning is open to your client. Nothing was emailed; they can open it from their account.",
  );
}
