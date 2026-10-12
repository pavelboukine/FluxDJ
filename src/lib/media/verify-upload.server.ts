import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { GEAR_MEDIA_TYPES, SNIFF_BYTES, sniffMediaType, type GearMediaType } from "@/lib/media/sniff";

const BUCKET = "gear-media";

export type UploadCheck = { ok: true; type: GearMediaType } | { ok: false; message: string; discard: boolean };

/**
 * Checks an object a staff member just uploaded to the gear-media bucket
 * (gear and package photos) before any record may point at it. Reads only
 * the first bytes and the total size, through a short-lived signed URL
 * issued to the staff user (so Storage RLS still applies), and accepts the
 * file only if its content is an allowed format, matches the declared type
 * and is within that type's size limit. `discard` says whether the object
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
  return { ok: true, type: detected };
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
