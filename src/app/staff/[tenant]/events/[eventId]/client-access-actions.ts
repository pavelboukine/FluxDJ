"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { fail, ok, text, UUID_RE, type ActionState } from "@/lib/forms";
import { planningInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";

/**
 * Invites the primary contact of an event booked elsewhere to plan it online.
 * send_planning_invitation checks staff, the booking source, planning setup,
 * the contact and archiving again in the database, and replaces any open
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
  return ok(`Planning invitation sent to ${result.recipient_email ?? "the client"}.`);
}
