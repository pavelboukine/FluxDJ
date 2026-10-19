"use server";

import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { LINK_TOKEN_PATTERN, sha256Hex } from "@/lib/proposals/tokens.server";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type PlanningSignInResult =
  | { status: "ok"; maskedEmail: string }
  | { status: "invalid" | "rate_limited" | "error" };

/**
 * Asks for a verification email to the invited address of a planning
 * invitation. The invitation token only authorizes this request; it never
 * signs anyone in or grants access. Rate limited per IP here and per
 * invitation in the database.
 */
export async function requestPlanningSignIn(slug: string, token: string): Promise<PlanningSignInResult> {
  if (!SLUG_PATTERN.test(slug) || !LINK_TOKEN_PATTERN.test(token)) return { status: "invalid" };
  if (!(await allowRequest("planning_sign_in", await clientIp(), 10, 900))) return { status: "rate_limited" };
  const { data, error } = await createAdminClient().rpc("request_planning_sign_in", { p_token_hash: sha256Hex(token), p_tenant_slug: slug });
  if (error) return { status: "error" };
  const result = data as { status: string; masked_email?: string };
  if (result.status === "ok" && result.masked_email) {
    after(() => processOutboxQuietly());
    return { status: "ok", maskedEmail: result.masked_email };
  }
  return { status: result.status === "rate_limited" ? "rate_limited" : "invalid" };
}

/**
 * The invitation's id when the visitor is already signed in with the
 * verified invited address (for example a Flux client who opened their
 * contract on this device), so they skip a second verification email. Only
 * the holder of the token, signed in as that address, learns the id, which
 * their verification email would also carry. It grants nothing: the
 * invitation page rechecks everything and accepting is a separate POST.
 */
export async function signedInPlanningInvitation(slug: string, token: string): Promise<string | null> {
  if (!SLUG_PATTERN.test(slug) || !LINK_TOKEN_PATTERN.test(token)) return null;
  const { data: auth } = await (await createClient()).auth.getUser();
  const email = auth.user?.email_confirmed_at && auth.user.email ? auth.user.email.toLowerCase() : null;
  if (!email) return null;
  const { data } = await createAdminClient()
    .from("planning_invitations")
    .select("id, email, tenants!inner(slug)")
    .eq("token_hash", sha256Hex(token))
    .eq("tenants.slug", slug)
    .is("revoked_at", null)
    .maybeSingle();
  return data && data.email === email ? data.id : null;
}
