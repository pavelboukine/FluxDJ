import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { proposalLinkToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { configuredTransport, type EmailTransport } from "./transport.server";
import { renderEmail, type OutboxEventType } from "./templates";

export type OutboxRunResult = { claimed: number; sent: number; failed: number; cancelled: number };

/**
 * Delivers due emails from the durable outbox.
 *
 * Business state is always committed before an email is queued, so delivery
 * (and every retry) only sends mail: it never creates or changes proposals,
 * submissions or approvals. Claims use row locks with expiry, so concurrent
 * workers are safe; a crash after sending but before recording success can
 * resend that one email (at-least-once delivery).
 *
 * Proposal emails rebuild their link from the access link id (see
 * tokens.server.ts). They are cancelled instead of sent if the offer was
 * superseded or its link revoked in the meantime.
 */
export async function processOutbox(options: { transport?: EmailTransport; tenantId?: string; limit?: number } = {}): Promise<OutboxRunResult> {
  const admin = createAdminClient();
  const transport = options.transport ?? configuredTransport();
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  const fromAddress = serverEnv().EMAIL_FROM_ADDRESS;
  const result: OutboxRunResult = { claimed: 0, sent: 0, failed: 0, cancelled: 0 };

  const { data: rows, error } = await admin.rpc("claim_email_outbox", {
    p_limit: options.limit ?? 20,
    p_lock_seconds: 120,
    p_tenant_id: options.tenantId,
  });
  if (error) throw new Error(`Could not claim outbox emails (${error.code ?? "error"})`);

  for (const row of rows ?? []) {
    result.claimed += 1;
    try {
      let proposalLink: string | undefined;
      if (row.event_type === "proposal_sent") {
        if (!row.proposal_active || !row.link_usable || !row.access_link_id) {
          await admin.rpc("cancel_email_outbox", { p_id: row.id, p_reason: "The offer was superseded or its link revoked before delivery." });
          result.cancelled += 1;
          continue;
        }
        const token = proposalLinkToken(row.access_link_id);
        if (sha256Hex(token) !== row.link_token_hash) {
          await admin.rpc("fail_email_outbox", {
            p_id: row.id,
            p_error: "The link secret changed after this link was created. Send a new revision to issue a new link.",
            p_permanent: true,
          });
          result.failed += 1;
          continue;
        }
        proposalLink = `${appUrl}/${row.tenant_slug}/p#${token}`;
      }

      const email = renderEmail({
        eventType: row.event_type as OutboxEventType,
        tenantDisplayName: row.tenant_display_name,
        tenantSlug: row.tenant_slug,
        proposalId: row.entity_id,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        appUrl,
        proposalLink,
      });
      const sent = await transport.send({
        fromName: `${row.tenant_display_name} via Flux DJ`,
        fromAddress,
        to: row.recipient_email,
        replyTo: row.tenant_reply_to,
        ...email,
      });
      await admin.rpc("complete_email_outbox", { p_id: row.id, p_provider_message_id: sent.id });
      result.sent += 1;
    } catch (cause) {
      // Error text must never include the link: transports report status codes only.
      const message = cause instanceof Error ? cause.message.slice(0, 300) : "Unknown delivery error";
      await admin.rpc("fail_email_outbox", { p_id: row.id, p_error: message, p_permanent: false });
      result.failed += 1;
    }
  }
  return result;
}

/** Runs the outbox after the response, swallowing errors (they are recorded per email). */
export async function processOutboxQuietly(tenantId?: string): Promise<void> {
  try {
    await processOutbox({ tenantId, limit: 10 });
  } catch {
    // The worker (pnpm outbox:work), cron or the staff Email page will retry.
  }
}
