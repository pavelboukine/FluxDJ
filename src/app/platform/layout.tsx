import { AppShell } from "@/components/app/app-shell";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { platformNavigation } from "@/lib/navigation";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", staff: "Staff" };

/**
 * Platform administration. Every page and action checks the grant again.
 * There is no active business here, so the top bar shows a neutral label
 * instead of a business logo, and the wordmark leads back to /staff.
 */
export default async function PlatformLayout({ children }: LayoutProps<"/platform">) {
  const { supabase, user } = await requirePlatformAdmin();
  const [{ data: workspaces }, { data: plans }, { data: contracts }] = await Promise.all([
    supabase.rpc("my_workspaces"),
    supabase.rpc("my_plans").limit(1),
    supabase.rpc("my_contracts").limit(1),
  ]);
  const mine = workspaces ?? [];
  return (
    <AppShell
      navLabel="Platform"
      groups={platformNavigation({ hasWorkspaces: mine.length > 0 })}
      homeHref="/staff"
      center={<span className="block truncate text-sm font-medium text-muted-foreground">Platform administration</span>}
      account={{
        email: user.email ?? "",
        roleLabel: "Platform administrator",
        platformAdmin: true,
        workspaces: mine.map((w) => ({ slug: w.slug, displayName: w.display_name, role: ROLE_LABEL[w.role] ?? w.role, suspended: w.suspended })),
        clientArea: (plans?.length ?? 0) > 0 || (contracts?.length ?? 0) > 0,
      }}
    >
      {children}
    </AppShell>
  );
}
