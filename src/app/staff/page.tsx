import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { requireUser } from "@/lib/auth/staff";
import { signOut } from "@/app/auth/confirm/actions";

export default async function StaffHome() {
  const { supabase, user } = await requireUser();
  const { data: memberships } = await supabase
    .from("tenant_memberships")
    .select("role, tenants(slug, display_name)")
    .eq("user_id", user.id);
  const tenants = (memberships ?? []).flatMap((m) => (m.tenants ? [{ ...m.tenants, role: m.role }] : []));

  if (tenants.length === 1) redirect(`/staff/${tenants[0].slug}`);
  const platformAdmin = await isPlatformAdmin();
  // A platform administrator without a business of their own manages invitations.
  if (tenants.length === 0 && platformAdmin) redirect("/platform/invitations");
  // Signed in without any staff role: a client. Their home lists what they can read.
  if (tenants.length === 0) redirect("/my");

  return (
    <main className="mx-auto grid w-full max-w-md gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">Choose a business</h1>
      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {user.email} is signed in but has no staff access to any DJ business.
        </p>
      ) : (
        <ul className="grid gap-2">
          {tenants.map((t) => (
            <li key={t.slug}>
              <Link className="underline" href={`/staff/${t.slug}`}>
                {t.display_name}
              </Link>{" "}
              <span className="text-xs text-muted-foreground">({t.role})</span>
            </li>
          ))}
        </ul>
      )}
      {platformAdmin ? <Link className="underline text-sm" href="/platform/invitations">DJ invitations</Link> : null}
      <form action={signOut}>
        <Button variant="outline" type="submit">
          Sign out
        </Button>
      </form>
    </main>
  );
}
