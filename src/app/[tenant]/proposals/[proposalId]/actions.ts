"use server";

import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { saveClientDraft, submitClientSelection, type SaveDraftResult, type SubmitResult } from "@/lib/proposals/client-session.server";

/*
 * Client proposal actions. Server Actions are same-origin POSTs (Next.js
 * checks the Origin header) and the session cookie is SameSite=Lax, which
 * blocks cross-site requests. All arguments are untrusted: access comes only
 * from the HttpOnly session cookie, rechecked in the database on every call.
 */

export async function saveSelectionDraftAction(slug: string, proposalId: string, expectedVersion: number, draft: unknown): Promise<SaveDraftResult> {
  if (typeof slug !== "string" || typeof proposalId !== "string" || typeof expectedVersion !== "number") {
    return { status: "invalid_input" };
  }
  return saveClientDraft(slug, proposalId, expectedVersion, draft);
}

export async function submitSelectionAction(
  slug: string,
  proposalId: string,
  expectedDraftVersion: number,
  idempotencyKey: string,
  input: unknown,
): Promise<SubmitResult> {
  if (typeof slug !== "string" || typeof proposalId !== "string" || typeof expectedDraftVersion !== "number" || typeof idempotencyKey !== "string") {
    return { status: "invalid", errors: [] };
  }
  const result = await submitClientSelection(slug, proposalId, expectedDraftVersion, idempotencyKey, input);
  if (result.status === "submitted" && !result.replayed) after(() => processOutboxQuietly(result.tenantId));
  return result;
}
