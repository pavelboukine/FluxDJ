import Link from "next/link";
import { ArrowRight, CalendarHeart, Headphones } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PublicShell } from "@/components/app/public-shell";
import { signOut } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/**
 * The public front door, for DJs and for their clients: what Flux DJ is and
 * one clear way in for each. Signed-in visitors also see where they can go
 * now (their DJ dashboard, their events, or both); nothing redirects on its
 * own, and the buttons only lead to pages that check access themselves.
 */
export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  let isStaff = false;
  let hasEvents = false;
  if (user) {
    const [{ count }, { data: events }] = await Promise.all([
      supabase.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("removed_at", null),
      supabase.rpc("my_events"),
    ]);
    isStaff = (count ?? 0) > 0;
    hasEvents = Array.isArray(events) && events.length > 0;
  }

  const audiences = [
    {
      id: "dj",
      icon: Headphones,
      title: "I'm a DJ",
      text: "Manage your events, proposals, contracts and planning.",
      action: isStaff ? { href: "/staff", label: "Open your dashboard" } : { href: loginHref("dj"), label: "DJ sign in" },
      note: "Flux DJ is invite-only for now.",
    },
    {
      id: "client",
      icon: CalendarHeart,
      title: "I'm a client",
      text: "Review your event details, sign contracts and plan with your DJ.",
      action: user && hasEvents ? { href: "/my", label: "Open your events" } : { href: loginHref("client"), label: "Client sign in" },
      note: "Your DJ gives you access by email.",
    },
  ] as const;

  return (
    <PublicShell
      aside={
        user ? (
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">Sign out</Button>
          </form>
        ) : null
      }
    >
      <section aria-labelledby="home-heading" className="grid gap-5 pt-8 pb-10 text-center sm:pt-16 sm:pb-14">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">For DJs and their clients</p>
        <h1 id="home-heading" className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          Every great event starts with a plan.
        </h1>
        <p className="mx-auto max-w-xl text-lg text-pretty text-muted-foreground">
          One place for proposals, contracts and event planning. Built for DJs and the couples, families and companies they play for.
        </p>
      </section>

      {user ? (
        <section aria-label="You're signed in" className="mx-auto mb-6 grid w-full max-w-3xl gap-3 rounded-2xl border bg-card/80 p-4 text-sm shadow-sm backdrop-blur sm:flex sm:items-center sm:justify-between" data-testid="signed-in">
          <p className="[overflow-wrap:anywhere]">
            Signed in as <span className="font-medium">{user.email}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {isStaff ? <Link className={buttonVariants({ size: "sm" })} href="/staff">DJ dashboard</Link> : null}
            {hasEvents || !isStaff ? <Link className={buttonVariants({ size: "sm", variant: isStaff ? "outline" : "default" })} href="/my">Your events</Link> : null}
          </div>
        </section>
      ) : null}

      <div className="mx-auto grid w-full max-w-3xl gap-4 sm:grid-cols-2" data-testid="audiences">
        {audiences.map((a) => (
          <section key={a.id} aria-labelledby={`${a.id}-heading`} className="grid content-between gap-6 rounded-2xl border bg-card/90 p-6 shadow-sm backdrop-blur">
            <div className="grid gap-3">
              <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <a.icon className="size-5" />
              </span>
              <h2 id={`${a.id}-heading`} className="text-xl font-semibold tracking-tight">{a.title}</h2>
              <p className="text-muted-foreground">{a.text}</p>
            </div>
            <div className="grid gap-2">
              <Link className={cn(buttonVariants({ size: "lg" }), "w-full justify-between")} href={a.action.href}>
                {a.action.label}
                <ArrowRight aria-hidden />
              </Link>
              <p className="text-xs text-muted-foreground">{a.note}</p>
            </div>
          </section>
        ))}
      </div>
    </PublicShell>
  );
}
