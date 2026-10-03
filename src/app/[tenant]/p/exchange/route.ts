import { after, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { LINK_TOKEN_PATTERN, newSessionToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { PROPOSAL_COOKIE, proposalCookieOptions, SESSION_SECONDS, SLUG_PATTERN } from "@/lib/proposals/client-session.server";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

/**
 * Exchanges a proposal link token (sent in the POST body, never in a URL, so
 * it cannot reach access logs) for a proposal-scoped HttpOnly session cookie.
 * Same-origin JSON only, rate limited per client IP in Postgres. Opening a
 * link grants proposal access only: no signing identity, event access or
 * account is created.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin && host && new URL(origin).host === host);
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return reply({ status: "forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply({ status: "unsupported" }, 415);
  if (!SLUG_PATTERN.test(slug)) return reply({ status: "invalid" }, 404);
  if (!(await allowRequest("link_exchange", await clientIp(), 20, 600))) return reply({ status: "rate_limited" }, 429);

  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!LINK_TOKEN_PATTERN.test(token)) return reply({ status: "invalid" }, 404);

  const sessionToken = newSessionToken();
  const { data, error } = await createAdminClient().rpc("exchange_proposal_link", {
    p_token_hash: sha256Hex(token),
    p_session_hash: sha256Hex(sessionToken),
    p_tenant_slug: slug,
    p_session_seconds: SESSION_SECONDS,
  });
  if (error) return reply({ status: "error" }, 500);
  const result = data as { status: string; proposal_id?: string; tenant_id?: string; session_expires_at?: string };
  if (result.status !== "ok" || !result.proposal_id) {
    return reply({ status: result.status === "superseded" ? "superseded" : "invalid" }, 404);
  }

  // The first opening queues a staff notice; deliver it after responding.
  after(() => processOutboxQuietly(result.tenant_id));

  const maxAge = Math.max(60, Math.min(SESSION_SECONDS, Math.floor((Date.parse(result.session_expires_at ?? "") - Date.now()) / 1000) || SESSION_SECONDS));
  const response = reply({ status: "ok", redirect: `/${slug}/proposals/${result.proposal_id}` });
  response.cookies.set(PROPOSAL_COOKIE, sessionToken, proposalCookieOptions(slug, result.proposal_id, maxAge));
  return response;
}
