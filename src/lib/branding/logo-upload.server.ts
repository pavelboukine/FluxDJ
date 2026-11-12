import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { sniffMediaType } from "@/lib/media/sniff";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOGO_BUCKET } from "./logo.server";

/**
 * Business logo uploads (Settings, Branding). Kept apart from logo.server.ts,
 * which every staff page loads for display: only uploads need sharp, a native
 * image library that would otherwise load on every cold server start.
 *
 * Business logos. Accepted uploads are PNG, JPEG or WebP (never SVG), up to
 * LOGO_MAX_UPLOAD_BYTES and LOGO_MAX_INPUT_SIDE pixels a side. The content is
 * sniffed and decoded here, then re-encoded as a fresh PNG (transparency kept,
 * metadata dropped, EXIF orientation applied) that fits within
 * LOGO_OUTPUT_SIDE pixels without stretching, with its empty transparent edges
 * trimmed: logos are sized by their height, so a margin would shrink the visible
 * mark. Nothing visible is cropped, and an opaque background is kept as drawn,
 * because white could be part of the design. Only the re-encoded
 * file is stored, in the private tenant-logos bucket under
 * {tenant}/logos/{uuid}.png, and only after register_tenant_logo records it
 * can it become a business's active logo. Nothing is ever fetched from a URL.
 */
export const LOGO_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_INPUT_SIDE = 8000;
export const LOGO_OUTPUT_SIDE = 1024;
const LOGO_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHARP_FORMAT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

export type ProcessedLogo = { png: Buffer; sha256: string; width: number; height: number; needsDarkBackground: boolean };
export type LogoResult = { ok: true; logo: ProcessedLogo } | { ok: false; message: string };

/** Mostly light artwork (average visible luminance above this) is shown on a dark backdrop on light surfaces. */
const LIGHT_LOGO = 0.85;

const INVALID = "That file isn't a PNG, JPEG or WebP image we can read. SVG isn't supported.";

export async function processLogo(bytes: Buffer): Promise<LogoResult> {
  if (bytes.length === 0) return { ok: false, message: "Choose an image file." };
  if (bytes.length > LOGO_MAX_UPLOAD_BYTES) return { ok: false, message: "The logo must be 4 MB or smaller." };
  const type = sniffMediaType(bytes.subarray(0, 4096));
  if (!type || !ACCEPTED.has(type)) return { ok: false, message: INVALID };
  const options = { limitInputPixels: LOGO_MAX_INPUT_SIDE * LOGO_MAX_INPUT_SIDE, failOn: "error" as const, animated: false };
  try {
    const meta = await sharp(bytes, options).metadata();
    if (meta.format !== SHARP_FORMAT[type]) return { ok: false, message: INVALID };
    if ((meta.pages ?? 1) > 1) return { ok: false, message: "Animated images aren't supported. Upload a still image." };
    const width = meta.autoOrient?.width ?? meta.width ?? 0;
    const height = meta.autoOrient?.height ?? meta.height ?? 0;
    if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE) return { ok: false, message: `The logo must be at least ${LOGO_MIN_SIDE} pixels wide and tall.` };
    if (width > LOGO_MAX_INPUT_SIDE || height > LOGO_MAX_INPUT_SIDE) return { ok: false, message: `The logo must be at most ${LOGO_MAX_INPUT_SIDE} pixels a side.` };

    const fitted = await sharp(bytes, options)
      .rotate()
      .resize({ width: LOGO_OUTPUT_SIDE, height: LOGO_OUTPUT_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    const { data: png, info } = await trimTransparentEdges(fitted);
    if (png.length > LOGO_MAX_OUTPUT_BYTES) return { ok: false, message: "This image is too detailed for a logo. Try a simpler or smaller version." };

    // Visible pixels only: an empty (fully transparent) image is refused, and
    // mostly light artwork is marked to be shown on a dark backdrop.
    const sample = await sharp(png).ensureAlpha().resize(64, 64, { fit: "inside" }).raw().toBuffer();
    let weight = 0;
    let light = 0;
    for (let i = 0; i < sample.length; i += 4) {
      const alpha = sample[i + 3] / 255;
      if (alpha === 0) continue;
      const luminance = (0.2126 * sample[i] + 0.7152 * sample[i + 1] + 0.0722 * sample[i + 2]) / 255;
      weight += alpha;
      light += alpha * luminance;
    }
    if (weight < 1) return { ok: false, message: "This image is empty (fully transparent)." };
    return {
      ok: true,
      logo: { png, sha256: createHash("sha256").update(png).digest("hex"), width: info.width, height: info.height, needsDarkBackground: light / weight > LIGHT_LOGO },
    };
  } catch {
    return { ok: false, message: INVALID };
  }
}

/** Below this alpha (about 3%) a pixel can't be seen; exporters often leave such haze around artwork. */
const VISIBLE_ALPHA = 8;

type EncodedLogo = { data: Buffer; info: { width: number; height: number } };

/** Removes rows and columns with nothing visible. A logo with no margin, or nothing visible at all, is returned as is. */
async function trimTransparentEdges(logo: EncodedLogo): Promise<EncodedLogo> {
  const { width, height } = logo.info;
  const pixels = await sharp(logo.data).ensureAlpha().raw().toBuffer();
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < VISIBLE_ALPHA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  if (right < 0 || (box.width === width && box.height === height)) return logo;
  const data = await sharp(logo.data).extract(box).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  return { data, info: { width: box.width, height: box.height } };
}

/**
 * A white version of a single-colour logo on a transparent background, for dark backgrounds.
 *
 * Only for artwork where turning it white loses nothing: a real transparent background (at least
 * WHITE_MIN_TRANSPARENT of the pixels can't be seen) and one ink (every solid pixel within
 * WHITE_INK_TOLERANCE of the ink on each channel, allowing WHITE_STRAY_SHARE of strays for
 * compression noise). A logo that is already light needs no white version. Anything else (several
 * colours, a photo, an opaque background) returns null and is never recoloured.
 *
 * The result keeps every pixel's transparency, so the shape and its smooth edges are exactly the
 * original's; only the colour becomes white. It is a new PNG: the original is never changed.
 */
const WHITE_MIN_TRANSPARENT = 0.1;
const WHITE_INK_TOLERANCE = 48;
const WHITE_STRAY_SHARE = 0.01;
/** Pixels at least this opaque decide the ink; softer edge pixels only keep their transparency. */
const SOLID_ALPHA = 128;

export async function whiteLogoVersion(png: Buffer): Promise<ProcessedLogo | null> {
  try {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return null;
    const pixels = info.width * info.height;
    let transparent = 0;
    let solid = 0;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < VISIBLE_ALPHA) transparent++;
      if (data[i + 3] < SOLID_ALPHA) continue;
      solid++;
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
    }
    if (solid === 0 || transparent / pixels < WHITE_MIN_TRANSPARENT) return null;
    const ink = sum.map((c) => c / solid);
    if ((0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2]) / 255 > LIGHT_LOGO) return null;
    let strays = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < SOLID_ALPHA) continue;
      if (Math.abs(data[i] - ink[0]) > WHITE_INK_TOLERANCE || Math.abs(data[i + 1] - ink[1]) > WHITE_INK_TOLERANCE || Math.abs(data[i + 2] - ink[2]) > WHITE_INK_TOLERANCE) strays++;
    }
    if (strays / solid > WHITE_STRAY_SHARE) return null;

    const white = Buffer.from(data);
    for (let i = 0; i < white.length; i += 4) {
      white[i] = 255;
      white[i + 1] = 255;
      white[i + 2] = 255;
    }
    const out = await sharp(white, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    if (out.length > LOGO_MAX_OUTPUT_BYTES) return null;
    return { png: out, sha256: createHash("sha256").update(out).digest("hex"), width: info.width, height: info.height, needsDarkBackground: true };
  } catch {
    return null;
  }
}

/** A stored logo's bytes (service role), after the caller's own authorization. Null if it can't be read. */
export async function storedLogoBytes(storagePath: string): Promise<Buffer | null> {
  const { data } = await createAdminClient().storage.from(LOGO_BUCKET).download(storagePath);
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

export type StoredLogo = { logoId: string; path: string };

/**
 * Stores a processed logo and registers it for the business (service role;
 * the database rechecks the owner and the stored object). If registration
 * fails, the upload is removed; a failure to remove it leaves an orphan that
 * private.unused_tenant_logos() lists. Either way the active logo is unchanged.
 */
export async function storeLogo(tenantId: string, userId: string, logo: ProcessedLogo): Promise<{ ok: true; stored: StoredLogo } | { ok: false; error: { code?: string; message?: string } | null }> {
  const admin = createAdminClient();
  const path = `${tenantId}/logos/${randomUUID()}.png`;
  const upload = await admin.storage.from(LOGO_BUCKET).upload(path, logo.png, { contentType: "image/png", upsert: false });
  if (upload.error) return { ok: false, error: null };
  const { data, error } = await admin.rpc("register_tenant_logo", {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_storage_path: path,
    p_sha256: logo.sha256,
    p_byte_size: logo.png.length,
    p_width: logo.width,
    p_height: logo.height,
    p_needs_dark_background: logo.needsDarkBackground,
  });
  if (error || !data) {
    await admin.storage.from(LOGO_BUCKET).remove([path]).catch(() => undefined);
    return { ok: false, error };
  }
  return { ok: true, stored: { logoId: data, path } };
}

