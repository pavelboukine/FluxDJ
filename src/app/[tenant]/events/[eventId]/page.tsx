import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, CalendarDays, ChevronRight, FileText, ListChecks, MapPin, ReceiptText } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { ClientFooter } from "@/components/app/client-footer";
import { ClientHeader } from "@/components/app/client-header";
import { CLIENT_FOCUS, CLIENT_PRIMARY, CLIENT_SHEET, EventStatusPill } from "@/components/app/client-event-ui";
import { ClientPayments } from "@/components/payments/client-payments";
import { signOut } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";
import { eventHubPath, hubNextStep, hubStatus, type HubStep } from "@/lib/client-event";
import { hubFacts, loadClientEvents, type ClientEventFacts } from "@/lib/client-event.server";
import { dateIn } from "@/lib/dates";
import { UUID_RE } from "@/lib/forms";
import { clientEditingText } from "@/lib/planning/cutoff";
import { formatEventDate, progressHeadline, progressPercent, progressPercentText } from "@/lib/planning/view";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your event", robots: { index: false, follow: false }, referrer: "strict-origin" };

/**
 * A client's home for one event, distinct from the planning workspace: its business's branding and status, one
 * full-width next step (with a planning summary when planning is next), then (for the contract's signer only)
 * the approved proposal, the contract and its payments. Every fact comes from the client
 * views behind /my (lib/client-event.server), which decide access in the database: an event this verified client
 * can't open, whatever the reason, gets the same neutral page, with nothing about the event or its business.
 */
export default async function EventHub({ params }: PageProps<"/[tenant]/events/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(eventId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(loginHref("client", eventHubPath(slug, eventId)));

  const [facts] = await loadClientEvents(supabase, { slug, eventId });
  if (!facts) return <Unavailable email={auth.user.email ?? null} />;

  const e = facts.home;
  const dj = e.tenantName;
  // Live branding, only after the access check above.
  const live = await liveBrand(slug);
  const status = hubStatus(e);
  const step = hubNextStep(hubFacts(facts));
  // Booked (here or elsewhere): planning is the next step, so the banner carries its progress.
  const planningLeads = e.bookingSource === "external" || e.lifecycle === "booked" || e.lifecycle === "completed";
  // Planning the client can open while something else comes first: a quiet way to it below the banner.
  const planningAside = !planningLeads && facts.plan ? <PlanningLink facts={facts} /> : null;

  return (
    <div data-plan-shell className="flex min-h-dvh flex-col bg-plan-canvas">
      <ClientHeader email={auth.user.email ?? null} back wide signOut={signOut} />
      <main style={brandStyle(live?.brandColors.primary)} className="mx-auto grid w-full max-w-5xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-8 sm:pt-8">
        <header className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-h-8 min-w-0 items-center text-sm">
              <BrandLogo logo={live?.logo ?? null} name={dj} className="max-h-9 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
            </span>
            <EventStatusPill label={status.label} tone={status.tone} />
          </div>
          <div className="grid gap-1.5">
            <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight text-balance [overflow-wrap:anywhere] sm:text-[1.75rem]">{e.title}</h1>
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
        </header>

        <NextStep step={step} plan={planningLeads ? facts.plan : null} dj={dj} />

        {/* The event's documents and payments (signer only), side by side on wide screens. */}
        {facts.contract ? (
          <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-2">
            <div className="grid gap-4 sm:gap-6">
              <Booking slug={slug} eventId={eventId} timezone={e.timezone} contract={facts.contract} />
              {planningAside}
            </div>
            <ClientPayments
              terms={facts.contract}
              signed={facts.contract.signing.signed}
              payments={facts.payments}
              djName={dj}
              className={cn(CLIENT_SHEET, "[--muted-foreground:var(--plan-ink-2)]")}
              headingClassName="text-lg leading-snug font-semibold"
            />
          </div>
        ) : planningAside ? (
          <div className="grid max-w-2xl">{planningAside}</div>
        ) : null}
      </main>
      <ClientFooter wide />
    </div>
  );
}

function StepAction({ step }: { step: HubStep }) {
  if (!step.action) return null;
  // A jump to details further down this page: a quiet link on phones, nothing on desktop (they're in view).
  if (step.action.href.startsWith("#")) {
    return (
      <p className="lg:hidden">
        <a href={step.action.href} className={cn("inline-flex min-h-11 items-center rounded-sm text-sm font-medium underline underline-offset-4", CLIENT_FOCUS)}>
          {step.action.label}
        </a>
      </p>
    );
  }
  return (
    <Link href={step.action.href} className={CLIENT_PRIMARY} data-testid="hub-primary">
      {step.action.label}
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}

/**
 * The one next step, full width on the business's Brand Tint: what to do and the way to do it. When planning is
 * the step it adds a one-line progress summary and the deadline, never the planning workspace itself.
 */
function NextStep({ step, plan, dj }: { step: HubStep; plan: ClientEventFacts["plan"]; dj: string }) {
  const percent = plan?.progress ? progressPercent(plan.progress) : null;
  return (
    <section
      aria-labelledby="next-step-heading"
      data-testid="hub-next-step"
      className="grid gap-4 bg-brand-tint p-4 max-sm:-mx-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8 sm:rounded-2xl sm:p-6"
    >
      <div className="grid min-w-0 gap-2">
        <h2 id="next-step-heading" className="text-lg leading-snug font-semibold text-balance">{step.title}</h2>
        {step.text ? <p className="max-w-[65ch] text-sm text-pretty text-plan-ink-2">{step.text}</p> : null}
        {plan?.progress && percent !== null ? (
          <div className="grid max-w-md gap-1.5 pt-1" data-testid="hub-progress">
            <p className="text-sm tabular-nums">
              <span className="font-semibold">{progressPercentText(plan.progress)}</span>
              <span className="text-plan-ink-2"> · {progressHeadline(plan.progress)}</span>
            </p>
            <div
              role="progressbar"
              aria-label="Required planning answers"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 overflow-hidden rounded-full bg-plan-surface"
            >
              <div className="h-full rounded-full bg-brand-ink" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
        {plan?.editing && plan.editing.state !== "closed" ? (
          <p className="text-sm text-plan-ink-2" data-testid="hub-deadline">{clientEditingText(plan.editing, dj)}</p>
        ) : null}
      </div>
      <StepAction step={step} />
    </section>
  );
}

/** Planning the client can open while another step comes first: one row to the planning overview. */
function PlanningLink({ facts }: { facts: ClientEventFacts }) {
  const plan = facts.plan!;
  const percent = plan.progress ? progressPercentText(plan.progress) : null;
  return (
    <section aria-labelledby="planning-heading" className={CLIENT_SHEET} data-testid="hub-planning">
      <h2 id="planning-heading" className="text-lg leading-snug font-semibold">Planning</h2>
      <Link
        href={`/${facts.home.tenantSlug}/planning/${facts.home.eventId}`}
        className={cn("-mx-2 flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-plan-track/60", CLIENT_FOCUS)}
      >
        <ListChecks aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
        <span className="grid min-w-0 flex-1">
          <span className="font-medium">{plan.editing?.state === "closed" ? "View your plan" : "Your planning"}</span>
          {percent ? <span className="text-plan-ink-2">{percent}</span> : null}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
      </Link>
    </section>
  );
}

/** The signer's documents: the approved proposal and the contract (its signed PDF downloads from the contract page). */
function Booking({ slug, eventId, timezone, contract }: { slug: string; eventId: string; timezone: string; contract: NonNullable<ClientEventFacts["contract"]> }) {
  const signed = contract.signing.signed ? contract.signing : null;
  const row = cn("-mx-2 flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-plan-track/60", CLIENT_FOCUS);
  return (
    <section aria-labelledby="booking-heading" className={CLIENT_SHEET} data-testid="hub-booking">
      <h2 id="booking-heading" className="text-lg leading-snug font-semibold">Booking documents</h2>
      <ul className="grid divide-y divide-plan-hairline">
        <li className="py-1 first:pt-0">
          <Link href={`${eventHubPath(slug, eventId)}/proposal`} className={row}>
            <FileText aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
            <span className="grid min-w-0 flex-1">
              <span className="font-medium">Approved proposal</span>
              <span className="text-plan-ink-2">The package, choices and prices you agreed</span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
          </Link>
        </li>
        <li className="py-1">
          <Link href={`/${slug}/contracts/${contract.id}`} className={row}>
            <ReceiptText aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
            <span className="grid min-w-0 flex-1">
              <span className="font-medium">{signed ? "Signed contract" : "Contract"}</span>
              <span className="text-plan-ink-2">
                {signed ? (signed.signedAt ? `Signed on ${formatEventDate(dateIn(timezone, new Date(signed.signedAt)))}` : "Signed") : !contract.signing.signed && contract.signing.enabled ? "Ready to sign" : "Ready to read"}
                {signed?.pdfReady ? " · PDF available" : null}
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
          </Link>
        </li>
      </ul>
      {signed?.pdfPending && !signed.pdfReady ? <p className="text-sm text-plan-ink-2">Your signed PDF is being prepared.</p> : null}
    </section>
  );
}

/** Any event this client can't open: one answer, naming nothing. */
function Unavailable({ email }: { email: string | null }) {
  return (
    <div data-plan-shell className="flex min-h-dvh flex-col bg-plan-canvas">
      <ClientHeader email={email} back signOut={signOut} />
      <main className="mx-auto grid w-full max-w-md px-4 py-12">
        <section className={CLIENT_SHEET}>
          <h1 className="text-xl font-semibold">This event isn&apos;t available</h1>
          <p className="text-sm text-plan-ink-2">
            It may no longer be active, or this account can&apos;t open it. If you think it should be available, contact your DJ.
          </p>
          <p className="text-sm">
            See <Link className="font-medium underline" href="/my">your events</Link>.
          </p>
        </section>
      </main>
      <ClientFooter />
    </div>
  );
}
