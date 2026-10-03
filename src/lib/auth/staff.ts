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
  if (!tenant) notFound();
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
