import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { sha256Hex } from "@/lib/proposals/tokens.server";

/** Best-effort client IP from proxy headers (trusts the hosting platform's proxy). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/**
 * Durable fixed-window rate limit shared by every server instance (stored in
 * Postgres). Subjects are hashed, so raw IPs are never stored. Fails closed:
 * if the limiter is unavailable, the request is refused.
 */
export async function allowRequest(bucket: string, subject: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("consume_rate_limit", {
    p_bucket: bucket,
    p_subject_hash: sha256Hex(`${bucket}:${subject}`),
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  return !error && data === true;
}
