"use server";

import { redirect } from "next/navigation";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";

/**
 * Grants the verified invited client access to the event, only on this
 * explicit POST. The database rechecks the session's verified email, the
 * invitation and the event under a lock; the client supplies no identity data.
 */
export async function acceptPlanningInvitation(slug: string, invitationId: string) {
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(invitationId)) redirect("/my");
  const supabase = await createClient();
  const { data } = await supabase.rpc("accept_planning_invitation", { p_invitation_id: invitationId, p_tenant_slug: slug });
  const result = data as { state?: string; event_id?: string } | null;
  if (result?.state === "accepted" && result.event_id && UUID_RE.test(result.event_id)) {
    redirect(`/${slug}/planning/${result.event_id}`);
  }
  redirect(`/${slug}/planning-invitations/${invitationId}`);
}
