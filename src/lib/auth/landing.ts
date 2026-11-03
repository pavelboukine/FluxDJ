import "server-only";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { requireUser } from "@/lib/auth/staff";

export type LandingWorkspace = { slug: string; display_name: string; role: string; suspended: boolean };

/**
 * Where a signed-in person lands (the /staff route and the installed app's
 * /start): their only business's dashboard, the business chooser when they
 * have several (or one that is suspended), platform administration for an
 * administrator without a business, and /my for everyone else (clients).
 * Only the verified user's own memberships are read; every destination
 * checks access again. Signed out: requireUser sends them to /login.
 */
export async function staffLanding(): Promise<{ redirect: string } | { choose: LandingWorkspace[] }> {
  const { supabase } = await requireUser();
  const { data: workspaces } = await supabase.rpc("my_workspaces");
  const all = workspaces ?? [];
  const active = all.filter((w) => !w.suspended);

  if (active.length === 1 && all.length === 1) return { redirect: `/staff/${active[0].slug}` };
  if (all.length === 0) return { redirect: (await isPlatformAdmin()) ? "/platform/invitations" : "/my" };
  return { choose: all };
}
