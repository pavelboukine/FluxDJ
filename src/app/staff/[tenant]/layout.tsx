import { AppShell } from "@/components/app/app-shell";
import { BrandLogo } from "@/components/app/brand-logo";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { signedLogoUrl, type BrandLogo as Logo } from "@/lib/branding/logo.server";
import { requireStaff, type StaffContext } from "@/lib/auth/staff";
import { staffNavigation } from "@/lib/navigation";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", staff: "Staff" };

export default async function StaffTenantLayout({ children, params }: LayoutProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, user, membership } = await requireStaff(slug);
  const [platformAdmin, { data: workspaces }, { data: plans }, { data: contracts }, logo] = await Promise.all([
    isPlatformAdmin(),
    supabase.rpc("my_workspaces"),
    // Client access (as on /my): only what this verified identity may read as a client.
    supabase.rpc("my_plans").limit(1),
    supabase.rpc("my_contracts").limit(1),
    activeLogo(supabase, tenant.id, tenant.logo_storage_path),
  ]);
  // Bounded on every side so the logo never meets the wordmark or the account button, even at 320 px.
  const logoBox = "max-h-8 max-w-[calc(100vw-16rem)] sm:max-w-[calc(100vw-20rem)] lg:max-h-9 lg:max-w-72";

  return (
    <AppShell
      navLabel="Staff"
      groups={staffNavigation(tenant.slug, { platformAdmin })}
      homeHref={`/staff/${tenant.slug}`}
      center={
        <div data-testid="workspace-brand" className="flex min-w-0 items-center justify-center">
          <BrandLogo logo={logo} name={tenant.display_name} className={logoBox} fallbackClassName={`block truncate text-sm font-semibold ${logoBox}`} />
        </div>
      }
      account={{
        email: user.email ?? "",
        roleLabel: `${ROLE_LABEL[membership.role] ?? membership.role} · ${tenant.display_name}`,
        platformAdmin,
        workspaces: (workspaces ?? []).map((w) => ({ slug: w.slug, displayName: w.display_name, role: ROLE_LABEL[w.role] ?? w.role, suspended: w.suspended })),
        currentSlug: tenant.slug,
        clientArea: (plans?.length ?? 0) > 0 || (contracts?.length ?? 0) > 0,
      }}
    >
      {children}
    </AppShell>
  );
}

/**
 * The active workspace's own logo: its registered details (RLS: only the
 * business's members read them) and a signed URL, fetched together. The path
 * comes from the tenant row requireStaff read as this member; the URL is used
 * only when the logo is registered for this business.
 */
async function activeLogo(supabase: StaffContext["supabase"], tenantId: string, path: string | null): Promise<Logo | null> {
  if (!path) return null;
  const [{ data: row }, url] = await Promise.all([
    supabase.from("tenant_logos").select("needs_dark_background, width, height").eq("tenant_id", tenantId).eq("storage_path", path).maybeSingle(),
    signedLogoUrl(path),
  ]);
  if (!row || !url) return null;
  return { url, needsDarkBackground: row.needs_dark_background === true, width: row.width, height: row.height };
}
