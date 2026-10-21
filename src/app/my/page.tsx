import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays, MapPin } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { CLIENT_FOCUS, CLIENT_PRIMARY, CLIENT_SECONDARY, EventStatusPill } from "@/components/app/client-event-ui";
import { InstallHelp } from "@/components/app/pwa";
import { ClientFooter } from "@/components/app/client-footer";
import { ClientHeader } from "@/components/app/client-header";
import { signOut, signOutToClientSignIn } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand, type BrandLogo as Logo } from "@/lib/branding/logo.server";
import { eventHubPath, hubNextStep } from "@/lib/client-event";
import { hubFacts, loadClientEvents, type ClientEventFacts } from "@/lib/client-event.server";
import { homeCard, splitByDate } from "@/lib/client-home";
import { formatEventDate, progressPercentText } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your events", robots: { index: false, follow: false } };

type Brand = { logo: Logo | null; primary: string | undefined };

/**
 * The client's events, across every business they work with: each card
 * carries its own business's branding, status and next step (the same words as
 * the event's hub), and leads to that hub. Every fact comes from client views
 * that check access in the database (lib/client-event.server, shared with
 * each hub); this page never reads staff data. The page itself stays neutral
 * (Flux), since its events can belong to different businesses.
 */
export default async function MyEvents() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(loginHref("client", "/my"));
  const user = auth.user;
  const [facts, { count: memberships }] = await Promise.all([
    loadClientEvents(supabase),
    supabase.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("removed_at", null),
  ]);

  // Each business's current branding (after the access checks above), once per business.
  const brands = new Map<string, Brand>();
  await Promise.all(
    [...new Set(facts.map((f) => f.home.tenantSlug))].map(async (slug) => {
      const live = await liveBrand(slug);
      brands.set(slug, { logo: live?.logo ?? null, primary: live?.brandColors.primary });
    }),
  );

  const { upcoming, past } = splitByDate(
    facts.map((f) => ({ ...f, eventDate: f.home.eventDate, timezone: f.home.timezone })),
    new Date(),
  );

  return (
    <div data-plan-shell className="flex min-h-dvh flex-col bg-plan-canvas">
      <ClientHeader email={user.email ?? null} staffLink={memberships ? "/staff" : null} signOut={signOut} />
      <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 pt-6 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-8 sm:pt-10">
        <InstallHelp />
        <div className="grid gap-1.5">
          <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight sm:text-[1.75rem]">Your events</h1>
          <p className="max-w-[60ch] text-sm text-pretty text-plan-ink-2">
            {facts.length > 0
              ? "Open an event for its booking documents, payments and planning."
              : "Events your DJ shares with you appear here."}
          </p>
        </div>

        {facts.length === 0 ? <NoEvents email={user.email ?? null} /> : null}

        {upcoming.length > 0 ? (
          <section aria-labelledby="upcoming-heading" className="grid gap-3">
            <h2 id="upcoming-heading" className="text-sm font-semibold text-plan-ink-2">
              Upcoming
            </h2>
            <ul className="grid gap-4">
              {upcoming.map((f) => (
                <EventCard key={f.home.eventId} facts={f} brand={brands.get(f.home.tenantSlug)} />
              ))}
            </ul>
          </section>
        ) : facts.length > 0 ? (
          <p className="text-sm text-plan-ink-2" data-testid="no-upcoming">No upcoming events. Your past events are below.</p>
        ) : null}

        {past.length > 0 ? (
          <details className="group/past grid gap-3" open={upcoming.length === 0}>
            <summary className={cn("flex min-h-11 w-fit cursor-pointer items-center rounded-md text-sm font-semibold text-plan-ink-2", CLIENT_FOCUS)}>
              Past events ({past.length})
            </summary>
            <ul className="mt-3 grid gap-4">
              {past.map((f) => (
                <EventCard key={f.home.eventId} facts={f} brand={brands.get(f.home.tenantSlug)} past />
              ))}
            </ul>
          </details>
        ) : null}
      </main>
      <ClientFooter />
    </div>
  );
}

/**
 * One event: whose it is (logo or name), what and when, its status and next step, and one way in: its hub,
 * where every document and planning link lives. On the business's Brand Ink; quieter for a past event.
 */
function EventCard({ facts, brand, past }: { facts: ClientEventFacts; brand: Brand | undefined; past?: boolean }) {
  const e = facts.home;
  const card = homeCard(e);
  const step = hubNextStep(hubFacts(facts));
  const progress = facts.plan?.progress && facts.plan.editing?.state !== "closed" ? progressPercentText(facts.plan.progress) : null;
  return (
    <li style={brandStyle(brand?.primary)} className="rounded-2xl border border-plan-hairline bg-plan-surface">
      <div className="grid gap-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-h-8 min-w-0 items-center text-sm">
            <BrandLogo logo={brand?.logo ?? null} name={e.tenantName} className="max-h-8 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
          </span>
          <EventStatusPill label={card.status} tone={card.tone} />
        </div>

        <div className="grid gap-1.5">
          <h3 className="text-lg leading-snug font-semibold text-balance [overflow-wrap:anywhere] sm:text-xl">{e.title}</h3>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-plan-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays aria-hidden className="size-4 shrink-0" />
              {formatEventDate(e.eventDate)}
            </span>
            {e.venueName ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
                <MapPin aria-hidden className="size-4 shrink-0" />
                {e.venueName}
              </span>
            ) : null}
          </p>
        </div>

        <div className="grid gap-1 border-t border-plan-hairline pt-4 text-sm" data-testid="event-next-step">
          <p className="font-medium text-pretty">
            {step.title}
            {progress ? <span className="font-normal text-plan-ink-2"> · {progress}</span> : null}
          </p>
          {step.text ? <p className="max-w-[60ch] text-pretty text-plan-ink-2">{step.text}</p> : null}
          {e.contract?.status === "signed" && e.contract.pdfPending && !e.contract.pdfReady ? (
            <p className="text-plan-ink-2">Your signed PDF is being prepared.</p>
          ) : null}
        </div>

        <div className="flex sm:justify-end">
          <Link href={eventHubPath(e.tenantSlug, e.eventId)} data-testid="event-hub-link" className={past ? CLIENT_SECONDARY : CLIENT_PRIMARY}>
            Open your event
            <span className="sr-only"> for {e.title}</span>
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </li>
  );
}

/** No event this account can open. The same answer whatever the reason (none yet, archived, another email), naming nothing. */
function NoEvents({ email }: { email: string | null }) {
  return (
    <section aria-labelledby="no-events-heading" data-testid="no-events" className="grid justify-items-start gap-4 rounded-2xl border border-plan-hairline bg-plan-surface p-5 sm:p-8">
      <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-plan-track text-plan-ink-2">
        <CalendarDays className="size-5" />
      </span>
      <div className="grid gap-1.5">
        <h2 id="no-events-heading" className="text-lg leading-snug font-semibold">No events to show yet</h2>
        <p className="max-w-[60ch] text-sm text-pretty text-plan-ink-2">
          When your DJ shares an event with {email ? <span className="font-medium text-foreground [overflow-wrap:anywhere]">{email}</span> : "this email address"}, you&apos;ll find it here. Proposals open from the link in your DJ&apos;s email and don&apos;t need an account.
        </p>
      </div>
      <div className="grid gap-2 border-t border-plan-hairline pt-4 text-sm text-plan-ink-2 justify-self-stretch">
        <p>Does your DJ have a different email address for you?</p>
        <form action={signOutToClientSignIn}>
          <button type="submit" className={CLIENT_SECONDARY}>
            Sign in with another email
          </button>
        </form>
      </div>
    </section>
  );
}
