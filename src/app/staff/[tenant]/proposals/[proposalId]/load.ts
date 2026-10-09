import "server-only";
import { notFound } from "next/navigation";
import { parseOfferSnapshot, type OfferSnapshot } from "@/lib/pricing";
import { describeDbError } from "@/lib/db-errors";
import { UUID_RE } from "@/lib/forms";
import type { StaffContext } from "@/lib/auth/staff";
import { frozenOfferLogo, type BrandLogo } from "@/lib/branding/logo.server";

export type PreviewResult =
  | { ok: true; offer: OfferSnapshot; logo: BrandLogo | null }
  | { ok: false; message: string };

export async function loadProposal({ supabase, tenant }: StaffContext, proposalId: string) {
  if (!UUID_RE.test(proposalId)) notFound();
  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, event_id, revision, status, draft_offer, draft_version, offer_frozen_at, source_template_id, events!proposals_event_fk(id, title, event_date, venue_name, active_proposal_id)")
    .eq("id", proposalId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!proposal) notFound();
  return proposal;
}

/**
 * Builds the preview through preview_proposal_offer: the same validation and
 * snapshot builder that freezing will use, but nothing is stored. Photos are
 * served by the proposal's staff media route (./media), resized.
 */
export async function loadPreview({ supabase }: StaffContext, proposalId: string): Promise<PreviewResult> {
  const { data, error } = await supabase.rpc("preview_proposal_offer", { p_proposal_id: proposalId });
  if (error) return { ok: false, message: describeDbError(error) };
  const offer = parseOfferSnapshot(data);
  // The logo this offer carries (the business's current logo for a draft, the frozen one once sent).
  return { ok: true, offer, logo: await frozenOfferLogo(offer) };
}

/** The staff media route for a proposal's preview (see lib/proposals/media). */
export function staffMediaBase(slug: string, proposalId: string): string {
  return `/staff/${slug}/proposals/${proposalId}/media`;
}
