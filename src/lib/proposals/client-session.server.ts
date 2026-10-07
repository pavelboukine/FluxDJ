import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicEnv } from "@/lib/env";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import {
  normalizeSelectionDraft,
  parseOfferSnapshot,
  priceSelection,
  toSelectionRecord,
  type AnswerValue,
  type OfferSnapshot,
  type PricedSelection,
  type PricingError,
} from "@/lib/pricing";
import { sha256Hex } from "./tokens.server";

/**
 * Anonymous proposal access.
 *
 * A link is exchanged (POST /{tenant}/p/exchange) for a random session token
 * in an HttpOnly, SameSite=Lax cookie scoped to /{tenant}/proposals/{id}. The
 * database stores only its hash. Every read and write below re-resolves the
 * session in the database, which rechecks tenant, proposal, revocation,
 * expiry, active proposal and state. The service-role client is used only
 * through those checked functions, and responses are explicit safe DTOs.
 */
export const PROPOSAL_COOKIE = "flux_proposal";
export const SESSION_SECONDS = 12 * 60 * 60;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function proposalCookiePath(slug: string, proposalId: string): string {
  return `/${slug}/proposals/${proposalId}`;
}

export function proposalCookieOptions(slug: string, proposalId: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: publicEnv().NEXT_PUBLIC_APP_URL.startsWith("https://"),
    path: proposalCookiePath(slug, proposalId),
    maxAge: maxAgeSeconds,
  };
}

async function sessionHash(): Promise<string | null> {
  const token = (await cookies()).get(PROPOSAL_COOKIE)?.value;
  return token && SESSION_TOKEN_PATTERN.test(token) ? sha256Hex(token) : null;
}

const answerValue = z.union([z.boolean(), z.string(), z.array(z.string())]);
const viewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("invalid") }),
  z.object({ state: z.literal("superseded") }),
  // The DJ's workspace is suspended: temporarily, nothing is shown or saved.
  z.object({ state: z.literal("unavailable") }),
  z.object({
    state: z.enum(["open", "expired", "submitted", "approved"]),
    tenant: z.object({ slug: z.string(), display_name: z.string() }),
    event: z.object({ title: z.string(), event_date: z.string(), venue_name: z.string().nullable(), timezone: z.string() }),
    proposal: z.object({
      id: z.string(),
      revision: z.number(),
      sent_at: z.string(),
      expires_at: z.string(),
      offer_sha256: z.string(),
      offer: z.unknown(),
    }),
    selection_draft: z
      .object({
        package_key: z.string().nullable(),
        addon_quantities: z.record(z.string(), z.number()),
        logistics_answers: z.record(z.string(), answerValue),
        version: z.number(),
      })
      .nullable(),
    submission: z.object({ version: z.number(), submitted_at: z.string(), selection: z.unknown() }).nullable(),
    approved_at: z.string().nullable(),
  }),
]);

export type ClientSelectionDraft = {
  package_key: string | null;
  addon_quantities: Record<string, number>;
  logistics_answers: Record<string, AnswerValue>;
  version: number;
};

export type ClientView =
  | { state: "invalid" }
  | { state: "superseded" }
  | { state: "unavailable" }
  | {
      state: "open" | "expired" | "submitted" | "approved";
      tenant: { slug: string; display_name: string };
      event: { title: string; event_date: string; venue_name: string | null; timezone: string };
      proposal: { id: string; revision: number; sent_at: string; expires_at: string; offer_sha256: string; offer: OfferSnapshot };
      selectionDraft: ClientSelectionDraft | null;
      submission: { version: number; submitted_at: string; selection: PricedSelection } | null;
      approvedAt: string | null;
    };

export async function loadClientView(slug: string, proposalId: string): Promise<ClientView> {
  if (!SLUG_PATTERN.test(slug) || !UUID_PATTERN.test(proposalId)) return { state: "invalid" };
  const hash = await sessionHash();
  if (!hash) return { state: "invalid" };
  const { data, error } = await createAdminClient().rpc("client_proposal_view", {
    p_session_hash: hash,
    p_proposal_id: proposalId,
    p_tenant_slug: slug,
  });
  if (error) return { state: "invalid" };
  const parsed = viewSchema.safeParse(data);
  if (!parsed.success) return { state: "invalid" };
  const view = parsed.data;
  if (view.state === "invalid" || view.state === "superseded" || view.state === "unavailable") return { state: view.state };
  return {
    state: view.state,
    tenant: view.tenant,
    event: view.event,
    proposal: { ...view.proposal, offer: parseOfferSnapshot(view.proposal.offer) },
    selectionDraft: view.selection_draft,
    submission: view.submission ? { ...view.submission, selection: view.submission.selection as PricedSelection } : null,
    approvedAt: view.approved_at,
  };
}

/** Short-lived signed URLs, only for media referenced by the frozen offer (verified at upload). */
export async function frozenOfferMediaUrls(offer: OfferSnapshot): Promise<Record<string, string>> {
  const paths = Object.values(offer.gear).flatMap((g) => g.media.map((m) => m.storage_path));
  if (paths.length === 0) return {};
  const { data } = await createAdminClient().storage.from("gear-media").createSignedUrls(paths, 600);
  const urls: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl) urls[item.path] = item.signedUrl;
  return urls;
}

export type SaveDraftResult =
  | { status: "ok"; version: number }
  | { status: "conflict" }
  | { status: "invalid_input"; errors?: PricingError[] }
  | { status: "rate_limited" }
  | { status: "closed"; state: string };

export async function saveClientDraft(slug: string, proposalId: string, expectedVersion: number, rawDraft: unknown): Promise<SaveDraftResult> {
  const hash = await sessionHash();
  if (!hash) return { status: "closed", state: "invalid" };
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { status: "invalid_input" };
  if (!(await allowRequest("proposal_save", hash, 120, 60))) return { status: "rate_limited" };

  const view = await loadClientView(slug, proposalId);
  if (view.state !== "open") return { status: "closed", state: view.state };
  const normalized = normalizeSelectionDraft(view.proposal.offer, rawDraft);
  if (!normalized.ok) return { status: "invalid_input", errors: normalized.errors };

  const { data, error } = await createAdminClient().rpc("client_save_selection_draft", {
    p_session_hash: hash,
    p_proposal_id: proposalId,
    p_tenant_slug: slug,
    p_expected_version: expectedVersion,
    // The SQL parameter accepts null (no package chosen yet).
    p_package_key: normalized.draft.package_key as string,
    p_addon_quantities: normalized.draft.addon_quantities,
    p_logistics_answers: normalized.draft.logistics_answers,
  });
  if (error) throw new Error("Could not save the selection");
  const result = data as { status: string; version?: number };
  if (result.status === "ok") return { status: "ok", version: result.version! };
  if (result.status === "conflict") return { status: "conflict" };
  if (result.status === "invalid_input") return { status: "invalid_input" };
  return { status: "closed", state: result.status };
}

export type SubmitResult =
  | { status: "submitted"; replayed: boolean; tenantId?: string }
  | { status: "invalid"; errors: PricingError[] }
  | { status: "conflict" }
  | { status: "rate_limited" }
  | { status: "closed"; state: string };

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Prices untrusted input on the server against the frozen offer and submits
 * it through client_submit_selection, which locks, rechecks the session and
 * state, enforces the idempotency key and draft version, and re-verifies
 * prices, taxes and choices before committing.
 */
export async function submitClientSelection(
  slug: string,
  proposalId: string,
  expectedDraftVersion: number,
  idempotencyKey: string,
  rawInput: unknown,
): Promise<SubmitResult> {
  const hash = await sessionHash();
  if (!hash) return { status: "closed", state: "invalid" };
  if (!Number.isInteger(expectedDraftVersion) || expectedDraftVersion < 0 || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return { status: "invalid", errors: [{ code: "input_invalid", path: "(root)", message: "Reload the page and try again." }] };
  }
  if (!(await allowRequest("proposal_submit", hash, 10, 60)) || !(await allowRequest("proposal_submit_ip", await clientIp(), 30, 600))) {
    return { status: "rate_limited" };
  }

  const view = await loadClientView(slug, proposalId);
  if (!("proposal" in view) || view.state === "expired") return { status: "closed", state: view.state };
  const priced = priceSelection(view.proposal.offer, rawInput);
  if (!priced.ok) return { status: "invalid", errors: priced.errors };

  const record = toSelectionRecord(priced.selection, view.proposal.offer_sha256);
  const { data, error } = await createAdminClient().rpc("client_submit_selection", {
    p_session_hash: hash,
    p_proposal_id: proposalId,
    p_tenant_slug: slug,
    p_expected_draft_version: expectedDraftVersion,
    p_idempotency_key: idempotencyKey,
    p_selection: JSON.parse(JSON.stringify(record)),
  });
  if (error) throw new Error("Could not submit the selection");
  const result = data as { status: string; replayed?: boolean; tenant_id?: string };
  if (result.status === "submitted") return { status: "submitted", replayed: Boolean(result.replayed), tenantId: result.tenant_id };
  if (result.status === "conflict") return { status: "conflict" };
  if (result.status === "invalid_selection" || result.status === "invalid_input") {
    return { status: "invalid", errors: [{ code: "input_invalid", path: "(root)", message: "Your selection could not be verified. Reload and try again." }] };
  }
  return { status: "closed", state: result.status };
}
