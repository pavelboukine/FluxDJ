import { AppShell } from "@/components/app/app-shell";
import { BrandLogo } from "@/components/app/brand-logo";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { logoUrl } from "@/lib/branding/logo.server";
import { requireStaff } from "@/lib/auth/staff";
import { staffNavigation } from "@/lib/navigation";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", staff: "Staff" };

export default async function StaffTenantLayout({ children, params }: LayoutProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, user, membership } = await requireStaff(slug);
  const [{ data: active }, platformAdmin, { data: workspaces }, { data: plans }, { data: contracts }] = await Promise.all([
    supabase.from("tenants").select("logo_storage_path").eq("id", tenant.id).single(),
    isPlatformAdmin(),
    supabase.rpc("my_workspaces"),
    // Client access (as on /my): only what this verified identity may read as a client.
    supabase.rpc("my_plans").limit(1),
    supabase.rpc("my_contracts").limit(1),
  ]);
  // The active workspace's own logo (RLS: only its members read its logos).
  const { data: logoRow } = active?.logo_storage_path
    ? await supabase.from("tenant_logos").select("storage_path, needs_dark_background, width, height").eq("tenant_id", tenant.id).eq("storage_path", active.logo_storage_path).maybeSingle()
    : { data: null };
  const logo = await logoUrl(logoRow);
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
