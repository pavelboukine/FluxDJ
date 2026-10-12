import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env.server";
import { parseProviderEvent, verifyWebhookSignature } from "@/lib/email/provider-events";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resend delivery webhooks: delivered, delayed, bounced, complained, failed
 * and suppressed, recorded on the outbox row with the same provider message
 * id (record_email_provider_event; the status only moves forward, so
 * duplicates and out-of-order events change nothing). Disabled (404) unless
 * RESEND_WEBHOOK_SECRET is set; unsigned or stale requests get 401. Other
 * event types are acknowledged and ignored. Nothing here sends or retries
 * email.
 */
export async function POST(request: Request) {
  const secret = serverEnv().RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ status: "not_found" }, { status: 404 });
  // Fail closed on a misconfigured secret (never accept unverifiable events).
  if (!/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret)) return NextResponse.json({ status: "misconfigured" }, { status: 503 });
  const body = await request.text();
  if (body.length > 256 * 1024) return NextResponse.json({ status: "too_large" }, { status: 413 });
  const genuine = verifyWebhookSignature(
    secret,
    { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
    body,
  );
  if (!genuine) return NextResponse.json({ status: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ status: "ignored" });
  }
  const event = parseProviderEvent(payload);
  if (!event) return NextResponse.json({ status: "ignored" });
  const { error } = await createAdminClient().rpc("record_email_provider_event", {
    p_provider_message_id: event.messageId,
    p_status: event.status,
    p_occurred_at: event.occurredAt,
    p_detail: event.detail as string,
  });
  // A database error is retried by Resend; the event itself is idempotent.
  if (error) return NextResponse.json({ status: "error" }, { status: 500 });
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
