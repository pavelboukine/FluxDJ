import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { GEAR_MEDIA_TYPES, SNIFF_BYTES, sniffMediaType, type GearMediaType } from "@/lib/media/sniff";
import { photoResolution, photoTooSmallMessage, type PhotoResolution } from "@/lib/media/resolution";

const BUCKET = "gear-media";

export type UploadCheck = { ok: true; type: GearMediaType; resolution?: PhotoResolution } | { ok: false; message: string; discard: boolean };

// The same decoding bounds the media route uses to serve photos.
const MAX_INPUT_PIXELS = 100_000_000;
const SHARP_FORMAT: Partial<Record<GearMediaType, string>> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/avif": "heif" };
const UNREADABLE = "That photo can't be read. Re-export it as JPEG, PNG or WebP and try again.";

/**
 * Checks an object a staff member just uploaded to the gear-media bucket
 * (gear and package photos) before any record may point at it. Reads only
 * the first bytes and the total size, through a short-lived signed URL
 * issued to the staff user (so Storage RLS still applies), and accepts the
 * file only if its content is an allowed format, matches the declared type
 * and is within that type's size limit. A photo is then read in full and
 * decoded, and refused if it can't be, or if it is smaller than the minimum
 * resolution (lib/media/resolution); `resolution` says whether it is sharp
 * enough for the full-screen viewer. `discard` says whether the object
 * should be removed (it exists but was refused).
 */
export async function checkUploadedMedia(supabase: SupabaseClient<Database>, path: string, declared: GearMediaType): Promise<UploadCheck> {
  const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (signError || !signed) return { ok: false, message: "Upload not found. Try again.", discard: false };
  const response = await fetch(signed.signedUrl, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, cache: "no-store" });
  if (!response.ok) return { ok: false, message: "The upload could not be read. Try again.", discard: true };
  const head = new Uint8Array(await response.arrayBuffer()).subarray(0, SNIFF_BYTES);
  const totalFromRange = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
  const size = Number(totalFromRange ?? response.headers.get("content-length") ?? NaN);

  const detected = sniffMediaType(head);
  if (detected === null) return { ok: false, message: "That file's contents are not a supported image or video.", discard: true };
  if (detected !== declared) return { ok: false, message: "The file's contents don't match its type. Re-export it and try again.", discard: true };
  if (!Number.isFinite(size) || size > GEAR_MEDIA_TYPES[detected].maxBytes) return { ok: false, message: "That file is too large.", discard: true };
  if (GEAR_MEDIA_TYPES[detected].kind !== "image") return { ok: true, type: detected };

  const full = await fetch(signed.signedUrl, { cache: "no-store" });
  if (!full.ok) return { ok: false, message: "The upload could not be read. Try again.", discard: true };
  const bytes = Buffer.from(await full.arrayBuffer());
  if (bytes.length > GEAR_MEDIA_TYPES[detected].maxBytes) return { ok: false, message: "That file is too large.", discard: true };
  const checked = await checkPhoto(bytes, detected);
  return checked.ok ? { ok: true, type: detected, resolution: checked.resolution } : { ok: false, message: checked.message, discard: true };
}

/**
 * Decodes a photo whose type was already sniffed: its format must match, it
 * must be a still image that actually decodes (a small decode, cheap with
 * shrink-on-load), and its displayed size must meet the minimum resolution.
 */
export async function checkPhoto(bytes: Buffer, type: GearMediaType): Promise<{ ok: true; resolution: PhotoResolution; width: number; height: number } | { ok: false; message: string }> {
  const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" as const, animated: false };
  try {
    const meta = await sharp(bytes, options).metadata();
    if (meta.format !== SHARP_FORMAT[type]) return { ok: false, message: UNREADABLE };
    const width = meta.autoOrient?.width ?? meta.width ?? 0;
    const height = meta.autoOrient?.height ?? meta.height ?? 0;
    await sharp(bytes, options).resize(64, 64, { fit: "inside" }).raw().toBuffer();
    const resolution = photoResolution(width, height);
    if (resolution === "too_small") return { ok: false, message: photoTooSmallMessage(width, height) };
    return { ok: true, resolution, width, height };
  } catch {
    return { ok: false, message: UNREADABLE };
  }
}

/** Removes a refused upload (staff have no delete access to the bucket). */
export async function discardUpload(path: string): Promise<void> {
  await createAdminClient().storage.from(BUCKET).remove([path]);
}

/** The declared type of an upload path chosen by the server, from its extension. */
export function declaredTypeOf(path: string): GearMediaType | null {
  const extension = path.split(".").pop();
  return (Object.keys(GEAR_MEDIA_TYPES) as GearMediaType[]).find((t) => GEAR_MEDIA_TYPES[t].extension === extension) ?? null;
}
