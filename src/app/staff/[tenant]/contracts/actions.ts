"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { processDocumentJobs } from "@/lib/contracts/documents.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { requireStaff } from "@/lib/auth/staff";
import type { MissingItem } from "@/lib/contracts/content";
import { describeDbError } from "@/lib/db-errors";
import { fail, ok, UUID_RE, type ActionState } from "@/lib/forms";

export type GenerateResult =
  | { status: "created" | "replayed"; contractId: string }
  | { status: "incomplete"; missing: MissingItem[] }
  | { status: "draft_exists"; contractId: string }
  | { status: "error"; message: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Generates (or explicitly replaces) the event's contract draft from an
 * approval and a published template version. All rendering and checks happen
 * in generate_contract_draft, in one transaction under the event lock.
 * Generating never sends anything, books the event or grants client access.
 */
export async function generateContract(
  slug: string,
  approvalId: string,
  input: { templateVersionId: string; balanceDueDate: string; replaceContractId: string | null },
): Promise<GenerateResult> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(approvalId)) return { status: "error", message: "Reload the page and try again." };
  if (!UUID_RE.test(input.templateVersionId)) return { status: "error", message: "Choose a published template version." };
  if (input.replaceContractId !== null && !UUID_RE.test(input.replaceContractId)) return { status: "error", message: "Reload the page and try again." };
  const balanceDueDate = input.balanceDueDate.trim();
  if (balanceDueDate && !DATE_RE.test(balanceDueDate)) return { status: "error", message: "Enter the balance due date as a date." };

  const { data, error } = await supabase.rpc("generate_contract_draft", {
    p_approval_id: approvalId,
    p_template_version_id: input.templateVersionId,
    ...(balanceDueDate ? { p_balance_due_date: balanceDueDate } : {}),
    ...(input.replaceContractId ? { p_replace_contract_id: input.replaceContractId } : {}),
  });
  if (error) return { status: "error", message: describeDbError(error) };
  const result = data as { status: string; contract_id?: string | null; missing?: MissingItem[] };
  revalidatePath(`/staff/${slug}`, "layout");
  switch (result.status) {
    case "created":
    case "replayed":
      return { status: result.status, contractId: result.contract_id! };
    case "incomplete":
      return { status: "incomplete", missing: result.missing ?? [] };
    case "draft_exists":
      return { status: "draft_exists", contractId: result.contract_id! };
    case "conflict":
      return { status: "error", message: "The contract draft changed since this page loaded. Reload the page and try again." };
    default:
      return { status: "error", message: "Something went wrong. Try again." };
  }
}

/**
 * Sends the contract in one database transaction (send_contract): it locks the
 * event, proposal and contract, re-runs the eligibility checks, marks the
 * contract sent, creates the invitation and queues the email. The invitation
 * token is derived from a fresh link id; only its hash goes to the database,
 * and the email worker re-derives it at delivery.
 */
export async function sendContract(slug: string, contractId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(contractId)) return fail("Reload the page and try again.");
  const linkId = randomUUID();
  const { data, error } = await supabase.rpc("send_contract", {
    p_contract_id: contractId,
    p_link_id: linkId,
    p_token_hash: sha256Hex(contractInviteToken(linkId)),
  });
  if (error) return fail(describeDbError(error));
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}`, "layout");
  const result = data as { recipient_email?: string; replayed?: boolean };
  return ok(result.replayed ? `Already sent to ${result.recipient_email}.` : `Sent to ${result.recipient_email}.`);
}

/** Issues a fresh invitation for an unchanged sent contract and revokes the previous one. */
export async function resendContract(slug: string, contractId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(contractId)) return fail("Reload the page and try again.");
  const linkId = randomUUID();
  const { data, error } = await supabase.rpc("resend_contract", {
    p_contract_id: contractId,
    p_link_id: linkId,
    p_token_hash: sha256Hex(contractInviteToken(linkId)),
  });
  if (error) return fail(describeDbError(error));
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(`Resent to ${(data as { recipient_email?: string }).recipient_email}. The previous invitation link no longer works.`);
}

/** Voids an unsigned sent contract. Its content and history are kept; the client can no longer read it. */
export async function voidContract(slug: string, contractId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(contractId)) return fail("Reload the page and try again.");
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 1 || reason.length > 500) return fail("Give a reason (up to 500 characters).");
  const { error } = await supabase.rpc("void_contract", { p_contract_id: contractId, p_reason: reason });
  if (error) return fail(describeDbError(error));
  // Deliver the queued "contract withdrawn" notice now (the worker also retries it).
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Contract voided. You can now generate a replacement from the current approval.");
}

/**
 * Generates the signed PDF if it is missing (contracts signed before PDFs
 * existed) or retries a failed generation. Never emails anyone; the
 * canonical PDF, once committed, is always reused.
 */
export async function generateSignedPdf(slug: string, contractId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(contractId)) return fail("Reload the page and try again.");
  const { data, error } = await supabase.rpc("request_signed_contract_pdf", { p_contract_id: contractId });
  if (error) return fail(describeDbError(error));
  if ((data as { status?: string }).status === "ready") return ok("The signed PDF is already available.");
  // Only this contract's job, after the database authorized the request for this tenant.
  await processDocumentJobs({ tenantId: tenant.id, contractId, limit: 1 }).catch(() => undefined);
  revalidatePath(`/staff/${slug}`, "layout");
  return ok("Signed PDF requested. No email was sent.");
}

/**
 * Emails the committed signed PDF to the frozen signer and business contact
 * after staff confirmed exactly those recipients. Deliveries that already
 * succeeded are never repeated; failed or cancelled ones are queued again.
 */
export async function sendSignedCopies(slug: string, contractId: string, recipients: string[]): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(contractId) || !Array.isArray(recipients) || recipients.length > 2) return fail("Reload the page and try again.");
  const { data, error } = await supabase.rpc("send_signed_contract_copies", { p_contract_id: contractId, p_recipients: recipients });
  if (error) return fail(describeDbError(error));
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}`, "layout");
  const rows = data as { email: string; status: string }[];
  return ok(rows.map((r) => `${r.email}: ${r.status === "sent" ? "already sent" : "queued"}`).join(" · "));
}
