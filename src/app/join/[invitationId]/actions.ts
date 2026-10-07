"use server";

import { redirect } from "next/navigation";
import { fail, text, UUID_RE, type ActionState } from "@/lib/forms";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { createClient } from "@/lib/supabase/server";

/**
 * Creates the invited DJ's workspace, only on this explicit POST. The
 * database rechecks the session's verified email, expiry, revocation and
 * acceptance under the invitation's lock, and creates the business, its owner
 * membership and the accepted invitation together. The browser supplies only
 * the name and address; the owner is always the signed-in user.
 */
export async function createWorkspace(invitationId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!UUID_RE.test(invitationId)) return fail("This invitation isn't available.");
  if (!(await allowRequest("workspace_create", await clientIp(), 20, 900))) {
    return fail("Too many attempts. Wait a few minutes and try again.");
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_platform_invitation", {
    p_invitation_id: invitationId,
    p_display_name: text(form, "display_name"),
    p_slug: text(form, "slug").toLowerCase(),
  });
  if (error) return fail("Something went wrong. Please try again.");
  const result = data as { state?: string; slug?: string };
  switch (result.state) {
    case "created":
      redirect(`/staff/${result.slug}?welcome=1`);
    case "slug_taken":
      return fail("That web address is already taken. Choose another one.");
    case "slug_invalid":
      return fail(
        "Choose a web address of 3 to 48 lowercase letters, numbers and single hyphens, starting and ending with a letter or number. Some words, such as “staff” or “login”, are reserved.",
      );
    case "name_invalid":
      return fail("Enter your business name (2 to 100 characters).");
    case "signed_out":
    case "unverified":
      return fail("Your sign-in has ended. Open the confirmation email again, or request a new one from your invitation.");
    case "wrong_account":
      return fail("You're signed in with a different email than the one invited. Reload the page to switch accounts.");
    default:
      return fail("This invitation isn't available any more. Ask for a new invitation.");
  }
}
