import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { staffLanding } from "@/lib/auth/landing";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { signOut } from "@/app/auth/confirm/actions";

export default async function StaffHome() {
  // One business: its dashboard. None: platform administration or /my (see staffLanding).
  const landing = await staffLanding();
  if ("redirect" in landing) redirect(landing.redirect);
  const all = landing.choose;
  const active = all.filter((w) => !w.suspended);
  const platformAdmin = await isPlatformAdmin();

  return (
    <main className="mx-auto grid w-full max-w-md gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">Choose a business</h1>
      <ul className="grid gap-2">
        {all.map((t) => (
          <li key={t.slug}>
            {t.suspended ? (
              <span className="text-muted-foreground">{t.display_name}</span>
            ) : (
              <Link className="underline" href={`/staff/${t.slug}`}>
                {t.display_name}
              </Link>
            )}{" "}
            <span className="text-xs text-muted-foreground">({t.suspended ? "unavailable" : t.role})</span>
          </li>
        ))}
      </ul>
      {active.length < all.length ? (
        <p className="text-sm text-muted-foreground">
          A business marked unavailable has been suspended by Flux DJ and can&apos;t be opened right now. Your other businesses and your
          sign-in aren&apos;t affected.
        </p>
      ) : null}
      {platformAdmin ? <Link className="underline text-sm" href="/platform/invitations">Platform administration</Link> : null}
      <form action={signOut}>
        <Button variant="outline" type="submit">
          Sign out
        </Button>
      </form>
    </main>
  );
}
