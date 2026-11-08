import type { Metadata } from "next";
import { BrandLogo } from "@/components/app/brand-logo";
import { PageHeader } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { brandTheme, normalizeHex } from "@/lib/branding/colors";
import { LOGO_SIZE, logoSizeLabel } from "@/lib/branding/logo-size";
import { logoUrl } from "@/lib/branding/logo.server";
import { previewLogo, saveBranding } from "../../actions";
import { BrandingForm } from "../../branding-form";
import { ReadOnlyRow, ReadOnlyRows } from "../../settings-section";

export const metadata: Metadata = { title: "Branding · Flux DJ" };

export default async function BrandingSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/branding">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase.from("tenants").select("display_name, brand_colors, logo_storage_path, branding_version, logo_size_percent").eq("id", tenant.id).single();
  const { data: activeLogo } = settings?.logo_storage_path
    ? await supabase.from("tenant_logos").select("storage_path, needs_dark_background, width, height").eq("tenant_id", tenant.id).eq("storage_path", settings.logo_storage_path).maybeSingle()
    : { data: null };
  const currentLogo = await logoUrl(activeLogo);
  const primaryColor = normalizeHex((settings?.brand_colors as Record<string, unknown> | null)?.primary);

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader
        title="Branding"
        description="Your logo and colour are optional. They appear on client pages and in emails from your business, and your logo also appears in your workspace header. Proposals already sent keep the branding they were sent with. Signed contract PDFs don't display your logo."
      />

      <div id="branding" className="scroll-mt-20 border-t pt-8">
        {membership.role === "owner" ? (
          <BrandingForm
            action={saveBranding.bind(null, slug)}
            preview={previewLogo.bind(null, slug)}
            version={settings?.branding_version ?? 0}
            displayName={settings?.display_name ?? tenant.display_name}
            currentLogo={currentLogo}
            currentColor={primaryColor}
            currentSize={settings?.logo_size_percent ?? LOGO_SIZE.default}
          />
        ) : (
          <div className="grid max-w-2xl gap-4">
            <p role="status" className="text-sm text-muted-foreground">Only the owner can change branding.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Logo">
                {currentLogo ? <BrandLogo logo={currentLogo} name={tenant.display_name} className="max-h-12 max-w-48" /> : "None (the business name is shown)"}
              </ReadOnlyRow>
              {currentLogo ? <ReadOnlyRow label="Logo size">{logoSizeLabel(settings?.logo_size_percent ?? LOGO_SIZE.default)}</ReadOnlyRow> : null}
              <ReadOnlyRow label="Primary colour">
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className="size-4 rounded border" style={{ background: brandTheme(primaryColor).color }} />
                  {primaryColor ?? "Default"}
                </span>
              </ReadOnlyRow>
            </ReadOnlyRows>
          </div>
        )}
      </div>
    </>
  );
}
