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

export type PlanningInvitationOpen = { brand: PublicBrand | null; signedIn: string | null };

/**
 * What the invitation page may show once the token in its link is known: the business's
 * branding, and whether the visitor can continue without a second verification email.
 * Branding only for a token of a live invitation of this URL's business (not revoked or
 * expired; business, event and client all active), so a guessed, stale or foreign link
 * shows nothing of any business and gets the neutral page. It grants nothing and reveals
 * nothing about the event or client: whether the invitation can be used is still decided
 * by request_planning_sign_in, and the invitation page rechecks everything.
 */
export async function openPlanningInvitation(slug: string, token: string): Promise<PlanningInvitationOpen> {
  const none = { brand: null, signedIn: null };
  if (!SLUG_PATTERN.test(slug) || !LINK_TOKEN_PATTERN.test(token)) return none;
  const admin = createAdminClient();
  const { data: invitation } = await admin
    .from("planning_invitations")
    .select("tenant_id, event_id, client_id, tenants!inner(slug)")
    .eq("token_hash", sha256Hex(token))
    .eq("tenants.slug", slug)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!invitation) return none;
  const [{ data: event }, { data: client }] = await Promise.all([
    admin.from("events").select("archived_at").eq("tenant_id", invitation.tenant_id).eq("id", invitation.event_id).maybeSingle(),
    admin.from("clients").select("archived_at").eq("tenant_id", invitation.tenant_id).eq("id", invitation.client_id).maybeSingle(),
  ]);
  if (!event || event.archived_at || !client || client.archived_at) return none;
  // Null for an archived or suspended business.
  const live = await liveBrand(slug);
  if (!live) return none;
  const brand: PublicBrand = { displayName: live.displayName, brandColors: live.brandColors, logo: live.logo ? { url: live.logo.url, needsDarkBackground: live.logo.needsDarkBackground } : null };
  return { brand, signedIn: await signedInPlanningInvitation(slug, token) };
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
