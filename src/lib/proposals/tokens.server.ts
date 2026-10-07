import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env.server";

/**
 * Proposal link tokens are derived, not stored:
 *
 *   token      = base64url(HMAC-SHA256(PROPOSAL_LINK_SECRET, "flux:proposal-link:v1:" + linkId))
 *   token_hash = hex(SHA-256(token))      <- the only value in the database
 *
 * 256 bits of entropy. The email outbox stores only the link id; a retry
 * re-derives the identical token, so retries never create new links and no
 * plaintext or encrypted token is ever persisted. Before sending, the worker
 * checks sha256(derived token) against the stored hash, which detects a
 * rotated secret.
 */
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function proposalLinkToken(linkId: string): string {
  return createHmac("sha256", serverEnv().PROPOSAL_LINK_SECRET).update(`flux:proposal-link:v1:${linkId}`).digest("base64url");
}

/**
 * Contract invitation tokens use the same derivation with a separate domain
 * prefix, so a proposal token can never be used as an invitation and vice
 * versa. An invitation token only lets the frozen signer request a
 * verification email; it never signs anyone in.
 */
export function contractInviteToken(linkId: string): string {
  return createHmac("sha256", serverEnv().PROPOSAL_LINK_SECRET).update(`flux:contract-invite:v1:${linkId}`).digest("base64url");
}

/**
 * DJ (platform) invitation tokens: same derivation, their own domain prefix.
 * The link id rotates on every resend, so earlier links stop working. The
 * token only lets the invited address ask for a verification email.
 */
export function platformInviteToken(linkId: string): string {
  return createHmac("sha256", serverEnv().PROPOSAL_LINK_SECRET).update(`flux:platform-invite:v1:${linkId}`).digest("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A random session token for the HttpOnly proposal cookie (stored only as a hash). */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
