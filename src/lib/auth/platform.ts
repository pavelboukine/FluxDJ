import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/staff";

/**
 * Whether the signed-in user is a platform administrator: an explicit grant
 * in public.platform_admins (see README, "DJ invitations"), never a tenant
 * role, an email or a slug. Navigation only; every invitation operation is
 * checked again by the database.
 */
export const isPlatformAdmin = cache(async () => {
  const { supabase } = await requireUser();
  const { data } = await supabase.rpc("current_user_is_platform_admin");
  return data === true;
});

/** The signed-in platform administrator, or a 404 for everyone else. */
export const requirePlatformAdmin = cache(async () => {
  const context = await requireUser();
  if (!(await isPlatformAdmin())) notFound();
  return context;
});

/** Invitations expire 14 days after they are sent or resent (enforced by the database). */
export const INVITATION_DAYS = 14;
