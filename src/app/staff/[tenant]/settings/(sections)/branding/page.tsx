import type { Metadata } from "next";
import { BrandLogo } from "@/components/app/brand-logo";
import { PageHeader } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { brandGradientCss, brandTheme, normalizeHex, usesGradient } from "@/lib/branding/colors";
import { LOGO_SIZE, logoSizeLabel } from "@/lib/branding/logo-size";
import { logoUrl, withOnDark } from "@/lib/branding/logo.server";
import { storedLogoBytes, whiteLogoVersion } from "@/lib/branding/logo-upload.server";
import { previewLogo, saveBranding } from "../../actions";
import { BrandingForm } from "../../branding-form";
import { ReadOnlyRow, ReadOnlyRows } from "../../settings-section";

export const metadata: Metadata = { title: "Branding · Flux DJ" };

export default async function BrandingSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/branding">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("display_name, brand_colors, logo_storage_path, logo_on_dark_storage_path, branding_version, logo_size_percent")
    .eq("id", tenant.id)
    .single();
  const paths = [settings?.logo_storage_path, settings?.logo_on_dark_storage_path].filter((p): p is string => !!p);
  const { data: logos } = paths.length
    ? await supabase.from("tenant_logos").select("storage_path, needs_dark_background, width, height").eq("tenant_id", tenant.id).in("storage_path", paths)
    : { data: [] };
  const row = (path: string | null | undefined) => (path ? logos?.find((l) => l.storage_path === path) : null);
  const [currentLogo, currentDarkLogo, canTurnWhite] = await Promise.all([
    logoUrl(row(settings?.logo_storage_path)),
    logoUrl(row(settings?.logo_on_dark_storage_path)),
    // Whether a white version can be made from the current logo (owners only: it reads the file).
    membership.role === "owner" && settings?.logo_storage_path
      ? storedLogoBytes(settings.logo_storage_path).then(async (bytes) => (bytes ? (await whiteLogoVersion(bytes)) !== null : false))
      : false,
  ]);
  const brandColors = (settings?.brand_colors as Record<string, unknown> | null) ?? {};
  const primaryColor = normalizeHex(brandColors.primary);
  const accentColor = normalizeHex(brandColors.accent);
  const gradient = usesGradient(brandColors);

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader
        title="Branding"
        description="How your business looks to clients: on their pages, in emails from you, and in your workspace header. Proposals already sent keep the branding they were sent with."
      />

      <div id="branding" className="scroll-mt-20 border-t pt-8">
        {membership.role === "owner" ? (
          <BrandingForm
            action={saveBranding.bind(null, slug)}
            preview={previewLogo.bind(null, slug)}
            version={settings?.branding_version ?? 0}
            displayName={settings?.display_name ?? tenant.display_name}
            currentLogo={currentLogo}
            currentDarkLogo={currentDarkLogo}
            canTurnWhite={canTurnWhite}
            currentColor={primaryColor}
            currentAccent={accentColor}
            currentGradient={gradient}
            currentSize={settings?.logo_size_percent ?? LOGO_SIZE.default}
          />
        ) : (
          <div className="grid max-w-2xl gap-4">
            <p role="status" className="text-sm text-muted-foreground">Only the owner can change branding.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Logo">
                {currentLogo ? <BrandLogo surface="theme" logo={withOnDark(currentLogo, currentDarkLogo)} name={tenant.display_name} className="max-h-12 max-w-48" /> : "None (the business name is shown)"}
              </ReadOnlyRow>
              {currentLogo ? (
                <ReadOnlyRow label="Logo for dark backgrounds">
                  {currentDarkLogo ? (
                    <span className="inline-flex rounded-lg bg-neutral-900 p-2">
                      <BrandLogo surface="dark" logo={withOnDark(currentLogo, currentDarkLogo)} name={tenant.display_name} className="max-h-12 max-w-48" />
                    </span>
                  ) : (
                    "None"
                  )}
                </ReadOnlyRow>
              ) : null}
              {currentLogo ? <ReadOnlyRow label="Logo size">{logoSizeLabel(settings?.logo_size_percent ?? LOGO_SIZE.default)}</ReadOnlyRow> : null}
              <ReadOnlyRow label="Primary colour">
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className="size-4 rounded border" style={{ background: brandTheme(primaryColor).color }} />
                  {primaryColor ?? "Default"}
                </span>
              </ReadOnlyRow>
              <ReadOnlyRow label="Colour style">
                {gradient ? (
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className="h-4 w-10 rounded border" style={{ background: brandGradientCss(brandTheme(brandColors)) }} />
                    Gradient, with the accent colour {accentColor}
                  </span>
                ) : (
                  "Solid"
                )}
              </ReadOnlyRow>
            </ReadOnlyRows>
          </div>
        )}
      </div>
    </>
  );
}
