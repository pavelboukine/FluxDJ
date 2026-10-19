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
 * invitation. The form's request id is the invitation id, so a retried
 * submission is a replay with no second email. Nothing else sends it.
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
  const result = data as { recipient_email?: string };
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}/events/${eventId}`);
  // Queued, not yet sent: the card shows its delivery once the outbox has run.
  return ok(`Planning invitation queued for ${result.recipient_email ?? "the client"}. Its delivery status appears under Client access.`);
}
