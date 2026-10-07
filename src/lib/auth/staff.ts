import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** The signed-in user (verified with the auth server), or a redirect to /login. */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  return { supabase, user: data.user };
});

/**
 * The signed-in user's staff context for a tenant slug. Uses the user's own
 * client, so RLS decides: a non-member gets a 404, never another tenant's data.
 * Every page and Server Action under /staff/[tenant] calls this.
 */
export const requireStaff = cache(async (tenantSlug: string) => {
  const { supabase, user } = await requireUser();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, slug, display_name, business_name, currency, timezone, tax_categories, archived_at")
    .eq("slug", tenantSlug)
    .maybeSingle();
  if (!tenant) {
    // A member of a suspended workspace: a neutral "unavailable" page (no
    // reason, no administrator). Only the user's own memberships are read,
    // so non-members learn nothing about the workspace.
    const { data: mine } = await supabase.rpc("my_workspaces");
    if ((mine ?? []).some((w) => w.slug === tenantSlug && w.suspended)) redirect("/unavailable");
    // Signed in, but with no staff role anywhere: usually a client sign-in
    // link was opened in this browser and replaced the staff session (one
    // Supabase session per browser). Explain instead of a bare 404. This
    // depends only on the user's own memberships, never on the slug, so it
    // reveals nothing about other tenants; staff of other tenants still get 404.
    const { count } = await supabase.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id);
    if (!count) redirect("/login?notice=no-staff-access");
    notFound();
  }
  const { data: membership } = await supabase
    .from("tenant_memberships")
    .select("id, role")
    .eq("tenant_id", tenant.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) notFound();
  return { supabase, user, tenant, membership };
});

export type StaffContext = Awaited<ReturnType<typeof requireStaff>>;
