"use server";

import { after } from "next/server";
import type { PublicBrand } from "@/components/app/tenant-public-shell";
import { liveBrand } from "@/lib/branding/logo.server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { LINK_TOKEN_PATTERN, sha256Hex } from "@/lib/proposals/tokens.server";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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

export type ContractInvitationOpen = { brand: PublicBrand | null; signedIn: string | null };

/**
 * What the contract invitation page may show once the token in its link is known: the business's branding,
 * and, for a visitor already signed in as the contract's signer, the invitation to continue to without a second
 * verification email. Branding only for a token of a usable invitation of this URL's business, by the same rule
 * as private.contract_invitation (link not revoked or expired; contract sent on the event's current approved
 * proposal; event and business active), so a guessed, stale or foreign link shows nothing of any business.
 * It grants nothing and reveals nothing about the event, contract or client: the invitation page rechecks
 * everything after sign-in, and accepting is a separate POST.
 */
export async function openContractInvitation(slug: string, token: string): Promise<ContractInvitationOpen> {
  const none = { brand: null, signedIn: null };
  if (!SLUG_PATTERN.test(slug) || !LINK_TOKEN_PATTERN.test(token)) return none;
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("access_links")
    .select("id, tenant_id, contract_id, tenants!inner(slug)")
    .eq("purpose", "contract")
    .eq("token_hash", sha256Hex(token))
    .eq("tenants.slug", slug)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!link?.contract_id) return none;
  const { data: contract } = await admin
    .from("contracts")
    .select("status, event_id, proposal_id, signer_email")
    .eq("tenant_id", link.tenant_id)
    .eq("id", link.contract_id)
    .maybeSingle();
  if (!contract || contract.status !== "sent") return none;
  const [{ data: event }, { data: proposal }] = await Promise.all([
    admin.from("events").select("archived_at, active_proposal_id").eq("tenant_id", link.tenant_id).eq("id", contract.event_id).maybeSingle(),
    admin.from("proposals").select("status").eq("tenant_id", link.tenant_id).eq("id", contract.proposal_id).maybeSingle(),
  ]);
  if (!event || event.archived_at || event.active_proposal_id !== contract.proposal_id || proposal?.status !== "approved") return none;
  // Null for an archived or suspended business.
  const live = await liveBrand(slug);
  if (!live) return none;
  const brand: PublicBrand = { displayName: live.displayName, brandColors: live.brandColors, logo: live.logo ? { url: live.logo.url, needsDarkBackground: live.logo.needsDarkBackground } : null };
  // Already signed in as the contract's signer (verified): continue to the invitation, which rechecks everything.
  const { data: auth } = await (await createClient()).auth.getUser();
  const email = auth.user?.email_confirmed_at && auth.user.email ? auth.user.email.toLowerCase() : null;
  return { brand, signedIn: email && email === contract.signer_email.toLowerCase() ? link.id : null };
}
