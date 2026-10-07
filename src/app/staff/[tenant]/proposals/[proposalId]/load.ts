import "server-only";
import { notFound } from "next/navigation";
import { parseOfferSnapshot, type OfferSnapshot } from "@/lib/pricing";
import { describeDbError } from "@/lib/db-errors";
import { UUID_RE } from "@/lib/forms";
import type { StaffContext } from "@/lib/auth/staff";
import { frozenOfferLogo, type BrandLogo } from "@/lib/branding/logo.server";

export type PreviewResult =
  | { ok: true; offer: OfferSnapshot; mediaUrls: Record<string, string>; logo: BrandLogo | null }
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
 * snapshot builder that freezing will use, but nothing is stored. Media gets
 * short-lived signed URLs issued to the staff user.
 */
export async function loadPreview({ supabase }: StaffContext, proposalId: string): Promise<PreviewResult> {
  const { data, error } = await supabase.rpc("preview_proposal_offer", { p_proposal_id: proposalId });
  if (error) return { ok: false, message: describeDbError(error) };
  const offer = parseOfferSnapshot(data);
  const paths = Object.values(offer.gear).flatMap((g) => g.media.map((m) => m.storage_path));
  const mediaUrls: Record<string, string> = {};
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage.from("gear-media").createSignedUrls(paths, 900);
    for (const s of signed ?? []) if (s.path && s.signedUrl) mediaUrls[s.path] = s.signedUrl;
  }
  // The logo this offer carries (the business's current logo for a draft, the frozen one once sent).
  return { ok: true, offer, mediaUrls, logo: await frozenOfferLogo(offer) };
}
