"use server";

import { redirect } from "next/navigation";
import { fail, UUID_RE, type ActionState } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";

/**
 * Accepts a staff invitation, only on this explicit POST. The database
 * rechecks the session's verified email, expiry, cancellation, acceptance and
 * the business's state under the invitation's lock, and creates (or restores)
 * the staff membership. The browser supplies only the invitation id; the
 * member is always the signed-in user.
 */
export async function acceptTeamInvitation(invitationId: string): Promise<ActionState> {
  if (!UUID_RE.test(invitationId)) return fail("This invitation isn't available.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_staff_invitation", { p_invitation_id: invitationId });
  if (error) return fail("Something went wrong. Please try again.");
  switch ((data as { state?: string }).state) {
    case "accepted":
      redirect(`/join/team/${invitationId}`);
    case "signed_out":
    case "unverified":
      return fail("Your sign-in has ended. Open your invitation email again to get a new confirmation link.");
    case "wrong_account":
      return fail("You're signed in with a different email than the one invited. Reload the page to switch accounts.");
    case "unavailable":
      return fail("This business's workspace is unavailable right now. Try again later.");
    default:
      return fail("This invitation isn't available any more. Ask the business for a new invitation.");
  }
}
