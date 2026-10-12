import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { isNotModified, mediaRefused, notModified, serveGearMedia } from "@/lib/media/proposal-media.server";
import { offerPackageMedia, parsePackageMediaRequest, type ImageWidth, type MediaItem } from "@/lib/proposals/media";
import { parseOfferSnapshot } from "@/lib/pricing";

type Context = RouteContext<"/staff/[tenant]/proposals/[proposalId]/package-media/[packageKey]">;

/**
 * A package's own photo for the staff proposal preview, authorized like the
 * staff gear media route: the offer comes from preview_proposal_offer as the
 * signed-in staff member (the frozen offer once sent), and the file must also
 * be a package photo record (current or replaced) of the business in the URL.
 */
async function authorize(request: Request, ctx: Context): Promise<Response | { media: MediaItem; width: ImageWidth }> {
  const { tenant: slug, proposalId, packageKey } = await ctx.params;
  const parsed = parsePackageMediaRequest(packageKey, new URL(request.url).searchParams.get("w"));
  if (!parsed || !UUID_RE.test(proposalId)) return mediaRefused(404);
  const { supabase, tenant } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("preview_proposal_offer", { p_proposal_id: proposalId });
  if (error || !data) notFound();
  const media = offerPackageMedia(parseOfferSnapshot(data), parsed.packageKey);
  if (!media) return mediaRefused(404);
  const { data: record } = await supabase.from("package_media").select("id").eq("tenant_id", tenant.id).eq("storage_path", media.storage_path).maybeSingle();
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
