import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseOfferSnapshot, priceSelection, toSelectionRecord, type PricedSelection, type PricingError } from "@/lib/pricing";

export type RecordSelectionResult =
  | { ok: true; selectionId: string; version: number; selection: PricedSelection }
  | { ok: false; reason: "invalid"; errors: PricingError[] }
  | { ok: false; reason: "version_conflict" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_frozen" };

/**
 * Prices untrusted client input against the proposal's frozen offer and stores
 * it as a new immutable submission. Editable (autosaved) choices belong in the
 * single mutable proposal_selection_drafts row instead.
 *
 * This performs NO caller authorization. It needs the service-role client, and
 * callers must first verify the proposal session, event, state and expiry
 * (the submission flow in Phase 1, step 6). The database re-verifies all
 * amounts against the frozen offer at commit.
 */
export async function priceAndRecordSelection(
  admin: SupabaseClient<Database>,
  proposalId: string,
  expectedVersion: number,
  input: unknown,
): Promise<RecordSelectionResult> {
  const { data: proposal, error } = await admin
    .from("proposals")
    .select("offer_snapshot, offer_sha256")
    .eq("id", proposalId)
    .maybeSingle();
  if (error) throw error;
  if (!proposal) return { ok: false, reason: "not_found" };
  // Submissions are only possible against a frozen offer (see freeze_proposal_offer).
  if (proposal.offer_snapshot === null || proposal.offer_sha256 === null) return { ok: false, reason: "not_frozen" };

  const offer = parseOfferSnapshot(proposal.offer_snapshot);
  const priced = priceSelection(offer, input);
  if (!priced.ok) return { ok: false, reason: "invalid", errors: priced.errors };

  const record = toSelectionRecord(priced.selection, proposal.offer_sha256);
  const { data: selectionId, error: rpcError } = await admin.rpc("record_proposal_selection", {
    p_proposal_id: proposalId,
    p_expected_version: expectedVersion,
    p_selection: JSON.parse(JSON.stringify(record)),
  });
  if (rpcError) {
    if (rpcError.code === "40001") return { ok: false, reason: "version_conflict" };
    throw rpcError;
  }
  return { ok: true, selectionId: selectionId as string, version: expectedVersion + 1, selection: priced.selection };
}
