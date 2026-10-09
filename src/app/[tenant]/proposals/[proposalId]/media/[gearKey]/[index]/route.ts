import { allowRequest } from "@/lib/rate-limit.server";
import { isNotModified, mediaRefused, notModified, serveGearMedia } from "@/lib/media/proposal-media.server";
import { offerMedia, parseMediaRequest, type ImageWidth, type MediaItem } from "@/lib/proposals/media";
import { loadClientView, sessionHash } from "@/lib/proposals/client-session.server";

type Context = RouteContext<"/[tenant]/proposals/[proposalId]/media/[gearKey]/[index]">;

/**
 * A photo or video of the client's frozen offer. The proposal session cookie
 * (scoped to this proposal's path) is rechecked in the database on every
 * request, exactly as for the page: a revoked, superseded, archived or
 * suspended proposal, an ended session or another business's proposal gets
 * nothing. The file is resolved from the frozen offer by gear key and
 * position; the request can't name a path. Viewing never extends access.
 */
async function authorize(request: Request, ctx: Context): Promise<Response | { media: MediaItem; width: ImageWidth }> {
  const { tenant: slug, proposalId, gearKey, index } = await ctx.params;
  const parsed = parseMediaRequest(gearKey, index, new URL(request.url).searchParams.get("w"));
  if (!parsed) return mediaRefused(404);
  const view = await loadClientView(slug, proposalId);
  if (view.state === "invalid") return mediaRefused(401);
  if (!("proposal" in view)) return mediaRefused(403);
  const media = offerMedia(view.proposal.offer, parsed.gearKey, parsed.index);
  return media ? { media, width: parsed.width } : mediaRefused(404);
}

export async function GET(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  if (access instanceof Response) return access;
  if (isNotModified(request, access.media, access.width)) return notModified(access.media, access.width);
  // Bounds Storage reads and resizing per session (a full page is a few requests per photo).
  if (!(await allowRequest("proposal_media", (await sessionHash()) ?? "none", 400, 600))) return mediaRefused(429);
  return serveGearMedia(access.media, access.width);
}

/** The page's check after a photo fails: access and existence only, no file work. */
export async function HEAD(request: Request, ctx: Context) {
  const access = await authorize(request, ctx);
  return new Response(null, { status: access instanceof Response ? access.status : 200, headers: { "Cache-Control": "no-store" } });
}
