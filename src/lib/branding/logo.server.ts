import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { sniffMediaType } from "@/lib/media/sniff";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Business logos. Accepted uploads are PNG, JPEG or WebP (never SVG), up to
 * LOGO_MAX_UPLOAD_BYTES and LOGO_MAX_INPUT_SIDE pixels a side. The content is
 * sniffed and decoded here, then re-encoded as a fresh PNG (transparency kept,
 * metadata dropped, EXIF orientation applied) that fits within
 * LOGO_OUTPUT_SIDE pixels without stretching or cropping. Only the re-encoded
 * file is stored, in the private tenant-logos bucket under
 * {tenant}/logos/{uuid}.png, and only after register_tenant_logo records it
 * can it become a business's active logo. Nothing is ever fetched from a URL.
 */
export const LOGO_BUCKET = "tenant-logos";
export const LOGO_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_INPUT_SIDE = 8000;
export const LOGO_OUTPUT_SIDE = 1024;
const LOGO_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHARP_FORMAT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

export type ProcessedLogo = { png: Buffer; sha256: string; width: number; height: number; needsDarkBackground: boolean };
export type LogoResult = { ok: true; logo: ProcessedLogo } | { ok: false; message: string };

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

    const { data: png, info } = await sharp(bytes, options)
      .rotate()
      .resize({ width: LOGO_OUTPUT_SIDE, height: LOGO_OUTPUT_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
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
      logo: { png, sha256: createHash("sha256").update(png).digest("hex"), width: info.width, height: info.height, needsDarkBackground: light / weight > 0.85 },
    };
  } catch {
    return { ok: false, message: INVALID };
  }
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

export type BrandLogo = { url: string; needsDarkBackground: boolean; width: number; height: number };

/** A short-lived URL for a registered logo, after the caller's own authorization. */
export async function logoUrl(details: { storage_path?: unknown; needs_dark_background?: unknown; width?: unknown; height?: unknown } | null | undefined): Promise<BrandLogo | null> {
  if (!details || typeof details.storage_path !== "string") return null;
  const { data } = await createAdminClient().storage.from(LOGO_BUCKET).createSignedUrl(details.storage_path, 3600);
  if (!data?.signedUrl) return null;
  return {
    url: data.signedUrl,
    needsDarkBackground: details.needs_dark_background === true,
    width: typeof details.width === "number" ? details.width : 0,
    height: typeof details.height === "number" ? details.height : 0,
  };
}

/** The logo frozen into a proposal offer when it was sent (still shown after the owner changes it). */
export async function frozenOfferLogo(offer: { branding: { logo_storage_path: string | null } }): Promise<BrandLogo | null> {
  const path = offer.branding.logo_storage_path;
  const tenantId = path?.split("/")[0];
  if (!path || !tenantId || !/^[0-9a-f-]{36}$/.test(tenantId)) return null;
  const { data } = await createAdminClient().rpc("tenant_logo_details", { p_tenant_id: tenantId, p_storage_path: path });
  return logoUrl(data as Record<string, unknown> | null);
}

/** The business's live logo, for client pages (after their access check) by slug. */
export async function liveBrand(slug: string): Promise<{ logo: BrandLogo | null; brandColors: Record<string, string>; displayName: string } | null> {
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  const brand = data as { display_name?: string; brand_colors?: Record<string, string>; logo_storage_path?: string | null; logo_needs_dark_background?: boolean; logo_width?: number; logo_height?: number } | null;
  if (!brand?.display_name) return null;
  const logo = brand.logo_storage_path
    ? await logoUrl({ storage_path: brand.logo_storage_path, needs_dark_background: brand.logo_needs_dark_background, width: brand.logo_width, height: brand.logo_height })
    : null;
  return { logo, brandColors: brand.brand_colors ?? {}, displayName: brand.display_name };
}
