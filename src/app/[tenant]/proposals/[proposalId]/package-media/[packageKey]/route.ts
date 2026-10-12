import { allowRequest } from "@/lib/rate-limit.server";
import { isNotModified, mediaRefused, notModified, serveGearMedia } from "@/lib/media/proposal-media.server";
import { offerPackageMedia, parsePackageMediaRequest, type ImageWidth, type MediaItem } from "@/lib/proposals/media";
import { loadClientView, sessionHash } from "@/lib/proposals/client-session.server";

type Context = RouteContext<"/[tenant]/proposals/[proposalId]/package-media/[packageKey]">;

/**
 * A package's own photo in the client's frozen offer, authorized exactly as
 * the gear media route: the proposal session is rechecked on every request
 * and the file is resolved from the frozen offer by package key, so the
 * request can't name a path, and a later catalog change never shows here.
 */
async function authorize(request: Request, ctx: Context): Promise<Response | { media: MediaItem; width: ImageWidth }> {
  const { tenant: slug, proposalId, packageKey } = await ctx.params;
  const parsed = parsePackageMediaRequest(packageKey, new URL(request.url).searchParams.get("w"));
  if (!parsed) return mediaRefused(404);
  const view = await loadClientView(slug, proposalId);
  if (view.state === "invalid") return mediaRefused(401);
  if (!("proposal" in view)) return mediaRefused(403);
  const media = offerPackageMedia(view.proposal.offer, parsed.packageKey);
  return media ? { media, width: parsed.width } : mediaRefused(404);
}

export async function GET(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  if (access instanceof Response) return access;
  if (isNotModified(request, access.media, access.width)) return notModified(access.media, access.width);
  // Shares the gear photos' per-session budget.
  if (!(await allowRequest("proposal_media", (await sessionHash()) ?? "none", 400, 600))) return mediaRefused(429);
  return serveGearMedia(access.media, access.width);
}

/** The page's check after a photo fails: access and existence only, no file work. */
export async function HEAD(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  return new Response(null, { status: access instanceof Response ? access.status : 200, headers: { "Cache-Control": "no-store" } });
}
