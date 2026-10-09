import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ImageWidth, MediaItem } from "@/lib/proposals/media";

/**
 * Serves one gear media item of an offer the caller is already authorized to
 * see (the caller resolves `media` from that offer; nothing here accepts a
 * path or URL from the request).
 *
 * Images: the original is read from the private gear-media bucket and
 * re-encoded on request as WebP, at most `width` pixels wide and tall
 * (proportions kept, never enlarged, never cropped, EXIF orientation applied,
 * metadata dropped). Nothing derived is stored: originals are immutable
 * (objects are never overwritten), so the response is safe for the viewer's
 * browser to keep privately, and a repeat request is answered 304 from the
 * ETag without touching Storage. Proposals frozen before this existed work
 * unchanged because only their storage paths are needed.
 *
 * Videos: a 302 to a short-lived signed URL of the original, so the browser
 * streams it with range requests directly from Storage. It is requested only
 * when the viewer presses play (the page never preloads videos).
 */
const BUCKET = "gear-media";
const VIDEO_URL_SECONDS = 600;
// Uploads are at most 15 MB; this bounds decoding work for unusual files.
const MAX_INPUT_PIXELS = 100_000_000;
// The browser keeps a photo for an hour; after that it revalidates (304), which
// re-checks access. Shared caches never store it.
const IMAGE_CACHE = "private, max-age=3600";

export function mediaEtag(storagePath: string, width: number): string {
  return `"${createHash("sha256").update(`v1:${storagePath}:${width}`).digest("base64url").slice(0, 32)}"`;
}

const plain = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

export const mediaRefused = (status: 401 | 403 | 404 | 429) =>
  plain(status, { 401: "Access has ended", 403: "Not available", 404: "Not found", 429: "Too many requests" }[status], status === 429 ? { "Retry-After": "60" } : {});

export function isNotModified(request: Request, media: MediaItem, width: ImageWidth): boolean {
  return media.kind === "image" && request.headers.get("if-none-match") === mediaEtag(media.storage_path, width);
}

export function notModified(media: MediaItem, width: ImageWidth): Response {
  return new Response(null, { status: 304, headers: { ETag: mediaEtag(media.storage_path, width), "Cache-Control": IMAGE_CACHE } });
}

export async function serveGearMedia(media: MediaItem, width: ImageWidth): Promise<Response> {
  const storage = createAdminClient().storage.from(BUCKET);
  if (media.kind === "video") {
    const { data } = await storage.createSignedUrl(media.storage_path, VIDEO_URL_SECONDS);
    if (!data?.signedUrl) return mediaRefused(404);
    return new Response(null, { status: 302, headers: { Location: data.signedUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  const { data: original, error } = await storage.download(media.storage_path);
  if (error || !original) return mediaRefused(404);
  try {
    const webp = await sharp(Buffer.from(await original.arrayBuffer()), { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false })
      .rotate()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return new Response(new Uint8Array(webp), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(webp.length),
        "Cache-Control": IMAGE_CACHE,
        ETag: mediaEtag(media.storage_path, width),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // An original that can't be decoded: the page shows its "photo unavailable" placeholder.
    return plain(422, "This photo can't be shown");
  }
}
