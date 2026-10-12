import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend webhooks (sent through Svix). A request is genuine when one of the
 * "v1," signatures in `svix-signature` equals base64(HMAC-SHA256(secret,
 * `${svix-id}.${svix-timestamp}.${raw body}`)), where the secret is the
 * base64 part of "whsec_…", and the timestamp is within five minutes (replay
 * protection). Only delivery outcomes are kept; opens and clicks are ignored
 * because email scanners trigger them.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhookSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature
    .split(" ")
    .map((part) => part.split(","))
    .some(([version, value]) => {
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

export type ProviderStatus = "delayed" | "delivered" | "failed" | "bounced" | "suppressed" | "complained";

const STATUS: Record<string, ProviderStatus> = {
  "email.delivery_delayed": "delayed",
  "email.delivered": "delivered",
  "email.failed": "failed",
  "email.bounced": "bounced",
  "email.suppressed": "suppressed",
  "email.complained": "complained",
};

export type ProviderEvent = { messageId: string; status: ProviderStatus; occurredAt: string; detail: string | null };

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The delivery outcome in a Resend webhook body, or null for events Flux
 * doesn't record (sent, opened, clicked, scheduled, received…) and malformed
 * bodies. The detail is a short category only (for example "Permanent ·
 * General" for a bounce): never addresses or message content.
 */
export function parseProviderEvent(payload: unknown): ProviderEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  const status = typeof event.type === "string" ? STATUS[event.type] : undefined;
  const messageId = text(event.data?.email_id, 200);
  const occurredAt = text(event.created_at, 64);
  if (!status || !messageId || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  let detail: string | null = null;
  if (status === "bounced") {
    const bounce = (event.data?.bounce ?? {}) as Record<string, unknown>;
    detail = [text(bounce.type, 40), text(bounce.subType, 40)].filter(Boolean).join(" · ") || null;
  } else if (status === "failed") {
    detail = text((event.data?.failed as Record<string, unknown> | undefined)?.reason, 120);
  }
  return { messageId, status, occurredAt: new Date(occurredAt).toISOString(), detail };
}
