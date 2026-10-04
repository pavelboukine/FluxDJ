"use server";

import { redirect } from "next/navigation";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";

/**
 * Grants the verified signer access to the event, only on this explicit POST.
 * The database rechecks the session's verified email, the invitation, the
 * contract and the event under a lock; the client supplies no identity data.
 */
export async function acceptInvitation(slug: string, linkId: string) {
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(linkId)) redirect("/my");
  const supabase = await createClient();
  const { data } = await supabase.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: slug });
  const result = data as { state?: string; contract_id?: string } | null;
  if (result?.state === "accepted" && result.contract_id && UUID_RE.test(result.contract_id)) {
    redirect(`/${slug}/contracts/${result.contract_id}`);
  }
  redirect(`/${slug}/invitations/${linkId}`);
}
