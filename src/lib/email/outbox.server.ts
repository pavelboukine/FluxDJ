import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { contractInviteToken, proposalLinkToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { IntegrityError, readVerifiedDocument } from "@/lib/contracts/documents.server";
import { formatSignedAt, signedPdfFileName } from "@/lib/contracts/pdf/data";
import { configuredTransport, type EmailTransport } from "./transport.server";
import {
  renderContractEmail,
  renderContractSignInEmail,
  renderContractVoidedEmail,
  renderEmail,
  renderSignedCopyEmail,
  type OutboxEventType,
  type RenderedEmail,
} from "./templates";

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
 *
 * Contract emails are rechecked the same way at dispatch (contract still sent
 * and current, invitation unrevoked and unexpired, event not archived):
 *  - "contract_sent" rebuilds the invitation link from the link id.
 *  - "contract_sign_in" asks Supabase Auth for a fresh verification link now,
 *    so no Auth token is ever stored. New identities get an invite link
 *    (Supabase creates the unconfirmed user; public signup stays disabled);
 *    existing identities get a magic link. Each attempt issues a new link and
 *    Supabase invalidates the previous one, so a retry after a crash can only
 *    leave the newest email usable. Access is granted only later, after the
 *    client verifies and confirms (accept_contract_invitation).
 *
 * Signed copies ("contract_signed_copy", one row per recipient) attach the
 * committed canonical PDF, read from private Storage and checked against its
 * recorded SHA-256 at send time; a mismatch fails permanently and visibly.
 * Resend gets an idempotency key per row, which closes the crash window for
 * 24 hours; Mailpit has none (local only). Every attempt is built only from
 * the row's frozen values (payload, frozen sender) and the canonical PDF, so
 * a retry is the same request even if Business settings changed meanwhile.
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
      if (row.event_type === "contract_signed_copy") {
        const outcome = await deliverSignedCopy(admin, transport, row, fromAddress);
        result[outcome] += 1;
        continue;
      }
      if (row.event_type === "contract_sent" || row.event_type === "contract_sign_in" || row.event_type === "contract_voided") {
        const outcome = await deliverContractEmail(admin, transport, row, appUrl, fromAddress);
        result[outcome] += 1;
        continue;
      }
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

type ClaimedRow = {
  id: string;
  event_type: string;
  recipient_email: string;
  payload: unknown;
  access_link_id: string | null;
  link_token_hash: string | null;
  contract_deliverable: boolean;
  contract_id: string | null;
  tenant_slug: string;
  tenant_display_name: string;
  tenant_reply_to: string | null;
};

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Creates a single-use Supabase verification link for the signer, now. Never stored. */
async function verificationLink(admin: ReturnType<typeof createAdminClient>, email: string, appUrl: string, next: string): Promise<string> {
  // Invite creates the identity when none exists (or refreshes an unverified
  // one); an already verified identity is reused through a magic link.
  let type: "invite" | "email" = "invite";
  let link = await admin.auth.admin.generateLink({ type: "invite", email });
  if (link.error && link.error.code === "email_exists") {
    type = "email";
    link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  }
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) throw new Error(`Could not create a verification link (${link.error?.status ?? "no token"})`);
  const params = new URLSearchParams({ token_hash: hashed, type, next });
  return `${appUrl}/auth/confirm?${params.toString()}`;
}

async function deliverContractEmail(
  admin: ReturnType<typeof createAdminClient>,
  transport: EmailTransport,
  row: ClaimedRow,
  appUrl: string,
  fromAddress: string,
): Promise<"sent" | "cancelled" | "failed"> {
  if (row.event_type === "contract_voided") {
    // Sent only while the contract is still void (always, once voided); no link, no reason.
    if (!row.contract_deliverable) {
      await admin.rpc("cancel_email_outbox", { p_id: row.id, p_reason: "The contract is not void." });
      return "cancelled";
    }
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const email = renderContractVoidedEmail({
      tenantDisplayName: row.tenant_display_name,
      legalName: str(payload.legal_name) || row.tenant_display_name,
      contactEmail: str(payload.contact_email) || null,
      clientName: str(payload.client_name) || "there",
      eventTitle: str(payload.event_title) || "your event",
    });
    const sent = await transport.send({ fromName: `${row.tenant_display_name} via Flux DJ`, fromAddress, to: row.recipient_email, replyTo: row.tenant_reply_to, ...email });
    await admin.rpc("complete_email_outbox", { p_id: row.id, p_provider_message_id: sent.id });
    return "sent";
  }
  if (!row.contract_deliverable || !row.access_link_id) {
    await admin.rpc("cancel_email_outbox", {
      p_id: row.id,
      p_reason: "The contract is no longer sent and current, its invitation was revoked or expired, or the event was archived.",
    });
    return "cancelled";
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  let email: RenderedEmail;
  if (row.event_type === "contract_sent") {
    const token = contractInviteToken(row.access_link_id);
    if (sha256Hex(token) !== row.link_token_hash) {
      await admin.rpc("fail_email_outbox", {
        p_id: row.id,
        p_error: "The link secret changed after this invitation was created. Resend the contract to issue a new invitation.",
        p_permanent: true,
      });
      return "failed";
    }
    email = renderContractEmail({
      tenantDisplayName: row.tenant_display_name,
      legalName: str(payload.legal_name) || row.tenant_display_name,
      contactEmail: str(payload.contact_email) || null,
      clientName: str(payload.client_name) || "there",
      eventTitle: str(payload.event_title) || "your event",
      depositCents: Number(payload.deposit_cents ?? 0),
      depositPercent: Number(payload.deposit_percent ?? 0),
      currency: str(payload.currency) || "CAD",
      invitationLink: `${appUrl}/${row.tenant_slug}/invite#${token}`,
      expiresAt: str(payload.invitation_expires_at) || null,
    });
  } else {
    const next = `/${row.tenant_slug}/invitations/${row.access_link_id}`;
    email = renderContractSignInEmail({
      tenantDisplayName: row.tenant_display_name,
      clientName: str(payload.client_name) || "there",
      eventTitle: str(payload.event_title) || "your event",
      verificationLink: await verificationLink(admin, row.recipient_email, appUrl, next),
    });
  }
  const sent = await transport.send({
    fromName: `${row.tenant_display_name} via Flux DJ`,
    fromAddress,
    to: row.recipient_email,
    replyTo: row.tenant_reply_to,
    ...email,
  });
  await admin.rpc("complete_email_outbox", { p_id: row.id, p_provider_message_id: sent.id });
  return "sent";
}

async function deliverSignedCopy(
  admin: ReturnType<typeof createAdminClient>,
  transport: EmailTransport,
  row: ClaimedRow,
  fromAddress: string,
): Promise<"sent" | "cancelled" | "failed"> {
  if (!row.contract_deliverable || !row.contract_id) {
    await admin.rpc("cancel_email_outbox", {
      p_id: row.id,
      p_reason: "The contract is not signed, its signed PDF is missing, or the event was archived.",
    });
    return "cancelled";
  }
  const { data: doc } = await admin
    .from("contract_documents")
    .select("storage_path, pdf_sha256, byte_size")
    .eq("contract_id", row.contract_id)
    .eq("kind", "signed_contract")
    .maybeSingle();
  if (!doc) {
    await admin.rpc("fail_email_outbox", { p_id: row.id, p_error: "The signed PDF is not available yet.", p_permanent: false });
    return "failed";
  }
  let pdf: Buffer;
  try {
    pdf = await readVerifiedDocument(admin, doc);
  } catch (cause) {
    const permanent = cause instanceof IntegrityError;
    await admin.rpc("fail_email_outbox", {
      p_id: row.id,
      p_error: cause instanceof Error ? cause.message.slice(0, 300) : "The signed PDF could not be read.",
      p_permanent: permanent,
    });
    return "failed";
  }
  // The sender frozen on the row: from name and reply-to when queued, from
  // address at the first attempt (rows queued earlier freeze everything now).
  const { data: frozen, error: freezeError } = await admin.rpc("freeze_email_sender", { p_id: row.id, p_from_address: fromAddress });
  const sender = frozen as { display_name?: unknown; from_name?: unknown; reply_to?: unknown; from_address?: unknown } | null;
  if (freezeError || !sender || typeof sender.display_name !== "string" || typeof sender.from_name !== "string" || typeof sender.from_address !== "string") {
    await admin.rpc("fail_email_outbox", { p_id: row.id, p_error: "The sender could not be prepared. It will be retried.", p_permanent: false });
    return "failed";
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const eventTitle = str(payload.event_title) || "your event";
  const eventDate = str(payload.event_date);
  const email = renderSignedCopyEmail({
    recipientRole: payload.recipient_role === "business" ? "business" : "client",
    tenantDisplayName: sender.display_name,
    legalName: str(payload.legal_name) || sender.display_name,
    contactEmail: str(payload.contact_email) || null,
    clientName: str(payload.client_name) || "there",
    typedName: str(payload.typed_name) || str(payload.client_name),
    eventTitle,
    eventDate,
    signedAtLocal: str(payload.signed_at) ? formatSignedAt(str(payload.signed_at), str(payload.timezone) || "America/Toronto").local : "the signing date",
  });
  const sent = await transport.send({
    fromName: sender.from_name,
    fromAddress: sender.from_address,
    to: row.recipient_email,
    replyTo: typeof sender.reply_to === "string" ? sender.reply_to : null,
    ...email,
    attachments: [{ filename: signedPdfFileName(eventTitle, eventDate), contentType: "application/pdf", content: pdf }],
    idempotencyKey: `flux-signed-copy-${row.id}`,
  });
  await admin.rpc("complete_email_outbox", { p_id: row.id, p_provider_message_id: sent.id });
  return "sent";
}

/** Runs the outbox after the response, swallowing errors (they are recorded per email). */
export async function processOutboxQuietly(tenantId?: string): Promise<void> {
  try {
    await processOutbox({ tenantId, limit: 10 });
  } catch {
    // The worker (pnpm outbox:work), cron or the staff Email page will retry.
  }
}
