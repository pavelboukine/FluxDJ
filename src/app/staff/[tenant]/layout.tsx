import { AppShell } from "@/components/app/app-shell";
import { BrandLogo } from "@/components/app/brand-logo";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { signedLogoUrl, type BrandLogo as Logo } from "@/lib/branding/logo.server";
import { requireStaff, type StaffContext } from "@/lib/auth/staff";
import { STAFF_HEADER_LOGO } from "@/lib/branding/logo-size";
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
    activeLogo(supabase, tenant.id, tenant.logo_storage_path, tenant.logo_on_dark_storage_path, tenant.logo_size_percent),
  ]);
  const logoBox = STAFF_HEADER_LOGO;

  return (
    <AppShell
      navLabel="Staff"
      groups={staffNavigation(tenant.slug, { platformAdmin })}
      homeHref={`/staff/${tenant.slug}`}
      center={
        <div data-testid="workspace-brand" className="flex min-w-0 items-center justify-center">
          {/* The header follows the staff theme: the logo for its light or dark background. */}
          <BrandLogo surface="theme" logo={logo} name={tenant.display_name} className={logoBox} fallbackClassName={`block truncate text-sm font-semibold ${logoBox}`} />
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
 * The active workspace's own logo, with its logo for dark backgrounds when it has one: registered
 * details (RLS: only the business's members read them) and signed URLs, fetched together. The paths
 * come from the tenant row requireStaff read as this member; a URL is used only when its logo is
 * registered for this business.
 */
async function activeLogo(
  supabase: StaffContext["supabase"],
  tenantId: string,
  path: string | null,
  darkPath: string | null,
  sizePercent: number,
): Promise<Logo | null> {
  if (!path) return null;
  const paths = darkPath ? [path, darkPath] : [path];
  const [{ data: rows }, url, darkUrl] = await Promise.all([
    supabase.from("tenant_logos").select("storage_path, needs_dark_background, width, height").eq("tenant_id", tenantId).in("storage_path", paths),
    signedLogoUrl(path),
    darkPath ? signedLogoUrl(darkPath) : null,
  ]);
  const row = rows?.find((r) => r.storage_path === path);
  if (!row || !url) return null;
  const logo: Logo = { url, needsDarkBackground: row.needs_dark_background === true, width: row.width, height: row.height, sizePercent };
  const dark = rows?.find((r) => r.storage_path === darkPath);
  return dark && darkUrl ? { ...logo, onDark: { url: darkUrl, width: dark.width, height: dark.height } } : logo;
}
