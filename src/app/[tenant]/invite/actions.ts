"use server";

import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { LINK_TOKEN_PATTERN, sha256Hex } from "@/lib/proposals/tokens.server";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { createAdminClient } from "@/lib/supabase/admin";

export type SignInRequestResult =
  | { status: "ok"; maskedEmail: string }
  | { status: "invalid" | "rate_limited" | "error" };

/**
 * Asks for a verification email to the contract's frozen signer address. The
 * invitation token only authorizes this request; it never signs anyone in or
 * grants access. Rate limited per IP here and per invitation in the database.
 */
export async function requestContractSignIn(slug: string, token: string): Promise<SignInRequestResult> {
  if (!SLUG_PATTERN.test(slug) || !LINK_TOKEN_PATTERN.test(token)) return { status: "invalid" };
  if (!(await allowRequest("contract_sign_in", await clientIp(), 10, 900))) return { status: "rate_limited" };
  const { data, error } = await createAdminClient().rpc("request_contract_sign_in", { p_token_hash: sha256Hex(token), p_tenant_slug: slug });
  if (error) return { status: "error" };
  const result = data as { status: string; masked_email?: string };
  if (result.status === "ok" && result.masked_email) {
    after(() => processOutboxQuietly());
    return { status: "ok", maskedEmail: result.masked_email };
  }
  return { status: result.status === "rate_limited" ? "rate_limited" : "invalid" };
}
