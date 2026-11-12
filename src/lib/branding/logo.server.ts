import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Business logos for display: short-lived signed URLs after the caller's own
 * authorization. Uploads (checks, re-encoding, storage) are in
 * logo-upload.server.ts, so pages that only show a logo never load sharp.
 * Logos live in the private tenant-logos bucket under {tenant}/logos/{uuid}.png.
 */
export const LOGO_BUCKET = "tenant-logos";

/** `onDark`: the business's own version of this logo for dark backgrounds, when it has one. */
export type LogoVariant = { url: string; width: number; height: number };
export type BrandLogo = { url: string; needsDarkBackground: boolean; width: number; height: number; sizePercent?: number; onDark?: LogoVariant };

/** A short-lived (one hour) signed URL for a stored logo, after the caller's own authorization. */
export async function signedLogoUrl(storagePath: string): Promise<string | null> {
  const { data } = await createAdminClient().storage.from(LOGO_BUCKET).createSignedUrl(storagePath, 3600);
  return data?.signedUrl ?? null;
}

/** A short-lived URL for a registered logo, after the caller's own authorization. */
export async function logoUrl(details: { storage_path?: unknown; needs_dark_background?: unknown; width?: unknown; height?: unknown } | null | undefined): Promise<BrandLogo | null> {
  if (!details || typeof details.storage_path !== "string") return null;
  const url = await signedLogoUrl(details.storage_path);
  if (!url) return null;
  return {
    url,
    needsDarkBackground: details.needs_dark_background === true,
    width: typeof details.width === "number" ? details.width : 0,
    height: typeof details.height === "number" ? details.height : 0,
  };
}

/**
 * The logo frozen into a proposal offer when it was sent (still shown after the owner changes it), with
 * the version for dark backgrounds if the offer froze one. An offer from before logo variants has no such
 * key and gets the logo alone, exactly as before. Each path must be a registered logo of the one business
 * whose folder the main logo is in; a variant that isn't is left out, never an error.
 */
export async function frozenOfferLogo(offer: { branding: { logo_storage_path: string | null; logo_on_dark_storage_path?: string | null } }): Promise<BrandLogo | null> {
  const path = offer.branding.logo_storage_path;
  const tenantId = path?.split("/")[0];
  if (!path || !tenantId || !/^[0-9a-f-]{36}$/.test(tenantId)) return null;
  const admin = createAdminClient();
  const { data } = await admin.rpc("tenant_logo_details", { p_tenant_id: tenantId, p_storage_path: path });
  const logo = await logoUrl(data as Record<string, unknown> | null);
  const darkPath = offer.branding.logo_on_dark_storage_path;
  if (!logo || !darkPath || !darkPath.startsWith(`${tenantId}/`)) return logo;
  const { data: dark } = await admin.rpc("tenant_logo_details", { p_tenant_id: tenantId, p_storage_path: darkPath });
  const variant = await logoUrl(dark as Record<string, unknown> | null);
  return variant ? { ...logo, onDark: { url: variant.url, width: variant.width, height: variant.height } } : logo;
}

/** The business's live logo, for client pages (after their access check) by slug. */
export async function liveBrand(slug: string): Promise<{ logo: BrandLogo | null; brandColors: Record<string, string>; displayName: string } | null> {
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  const brand = data as { display_name?: string; brand_colors?: Record<string, string>; logo_storage_path?: string | null; logo_needs_dark_background?: boolean; logo_width?: number; logo_height?: number; logo_size_percent?: number } | null;
  if (!brand?.display_name) return null;
  const stored = brand.logo_storage_path
    ? await logoUrl({ storage_path: brand.logo_storage_path, needs_dark_background: brand.logo_needs_dark_background, width: brand.logo_width, height: brand.logo_height })
    : null;
  const logo = stored ? { ...stored, sizePercent: brand.logo_size_percent } : null;
  return { logo, brandColors: brand.brand_colors ?? {}, displayName: brand.display_name };
}
