import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Business logos for display: short-lived signed URLs after the caller's own
 * authorization. Uploads (checks, re-encoding, storage) are in
 * logo-upload.server.ts, so pages that only show a logo never load sharp.
 * Logos live in the private tenant-logos bucket under {tenant}/logos/{uuid}.png.
 */
export const LOGO_BUCKET = "tenant-logos";

export type BrandLogo = { url: string; needsDarkBackground: boolean; width: number; height: number };

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
