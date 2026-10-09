import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { isNotModified, mediaRefused, notModified, serveGearMedia } from "@/lib/media/proposal-media.server";
import { offerMedia, parseMediaRequest, type ImageWidth, type MediaItem } from "@/lib/proposals/media";
import { parseOfferSnapshot } from "@/lib/pricing";

type Context = RouteContext<"/staff/[tenant]/proposals/[proposalId]/media/[gearKey]/[index]">;

/**
 * A photo or video for the staff proposal preview, resized like the client's.
 * The offer comes from preview_proposal_offer as the signed-in staff member
 * (staff of the proposal's own business only; the frozen offer once sent),
 * and the file must also be a gear media record of the business in the URL.
 */
async function authorize(request: Request, ctx: Context): Promise<Response | { media: MediaItem; width: ImageWidth }> {
  const { tenant: slug, proposalId, gearKey, index } = await ctx.params;
  const parsed = parseMediaRequest(gearKey, index, new URL(request.url).searchParams.get("w"));
  if (!parsed || !UUID_RE.test(proposalId)) return mediaRefused(404);
  const { supabase, tenant } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("preview_proposal_offer", { p_proposal_id: proposalId });
  if (error || !data) notFound();
  const media = offerMedia(parseOfferSnapshot(data), parsed.gearKey, parsed.index);
  if (!media) return mediaRefused(404);
  const { data: record } = await supabase.from("gear_media").select("id").eq("tenant_id", tenant.id).eq("storage_path", media.storage_path).maybeSingle();
  return record ? { media, width: parsed.width } : mediaRefused(404);
}

export async function GET(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  if (access instanceof Response) return access;
  if (isNotModified(request, access.media, access.width)) return notModified(access.media, access.width);
  return serveGearMedia(access.media, access.width);
}

export async function HEAD(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  return new Response(null, { status: access instanceof Response ? access.status : 200, headers: { "Cache-Control": "no-store" } });
}
