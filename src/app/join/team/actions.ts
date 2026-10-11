"use server";

import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { LINK_TOKEN_PATTERN, sha256Hex } from "@/lib/proposals/tokens.server";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type TeamInviteResult =
  | { status: "ok"; maskedEmail: string }
  | { status: "signed_in"; invitationId: string }
  | { status: "invalid" | "rate_limited" | "error" };

/**
 * Continues a staff invitation from its emailed link. Someone already signed
 * in with the verified invited address goes straight to acceptance; anyone
 * else gets a verification email sent to the invited address (never to an
 * address they choose). The token never signs anyone in or grants access.
 * Rate limited per IP here and per invitation in the database.
 */
export async function continueTeamInvitation(token: string): Promise<TeamInviteResult> {
  if (!LINK_TOKEN_PATTERN.test(token)) return { status: "invalid" };
  const tokenHash = sha256Hex(token);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (auth.user) {
    const { data: invitationId } = await supabase.rpc("staff_invitation_for_token", { p_token_hash: tokenHash });
    if (typeof invitationId === "string") return { status: "signed_in", invitationId };
  }
  if (!(await allowRequest("staff_sign_in", await clientIp(), 10, 900))) return { status: "rate_limited" };
  const { data, error } = await createAdminClient().rpc("request_staff_sign_in", { p_token_hash: tokenHash });
  if (error) return { status: "error" };
  const result = data as { status: string; masked_email?: string };
  if (result.status === "ok" && result.masked_email) {
    after(() => processOutboxQuietly());
    return { status: "ok", maskedEmail: result.masked_email };
  }
  return { status: result.status === "rate_limited" ? "rate_limited" : "invalid" };
}
