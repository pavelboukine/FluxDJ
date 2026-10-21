import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, ChevronRight, FileText, MapPin, ReceiptText } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { ClientHeader } from "@/components/app/client-header";
import { PdfDownloadLink } from "@/components/app/pwa";
import { ClientPayments } from "@/components/payments/client-payments";
import { ProgressMeter } from "@/components/planning/progress";
import { signOut } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";
import { eventHubPath, hubNextStep, hubStatus, type HubStep } from "@/lib/client-event";
import { loadClientEvents, type ClientEventFacts } from "@/lib/client-event.server";
import type { HomeTone } from "@/lib/client-home";
import { dateIn } from "@/lib/dates";
import { UUID_RE } from "@/lib/forms";
import { clientEditingText } from "@/lib/planning/cutoff";
import { formatEventDate, progressPercent } from "@/lib/planning/view";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your event", robots: { index: false, follow: false }, referrer: "strict-origin" };

/** One sheet on the planning canvas, as in client planning: edge to edge on phones, a rounded sheet from small screens up. */
const SHEET = "grid min-w-0 content-start gap-4 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6";
/** The primary action, on Brand Ink (white text stays readable on any brand colour). */
const PRIMARY = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-5 text-sm font-semibold max-sm:w-full",
  "bg-brand-ink text-white hover:bg-[color-mix(in_oklab,var(--brand-ink),black_14%)] active:bg-[color-mix(in_oklab,var(--brand-ink),black_22%)]",
  "transition-colors motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2",
);
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-1";
const TONES: Record<HomeTone, string> = {
  action: "bg-status-attention-tint text-status-attention",
  waiting: "bg-plan-track text-foreground",
  done: "bg-[color-mix(in_oklab,var(--status-done)_14%,white)] text-[color-mix(in_oklab,var(--status-done),black_25%)]",
  neutral: "bg-plan-track text-plan-ink-2",
};

/**
 * A client's home for one event: its business's branding, status, the one next step, planning, and (for the
 * contract's signer only) the approved proposal, the contract and its payments. Every fact comes from the client
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
  const percent = facts.plan?.progress ? progressPercent(facts.plan.progress) : null;
  const step = hubNextStep({
    home: e,
    contract: facts.contract
      ? { id: facts.contract.id, status: facts.contract.status, totalCents: facts.contract.totalCents, signable: facts.contract.signing.signed || facts.contract.signing.enabled }
      : null,
    plan: facts.plan ? { editing: facts.plan.editing?.state ?? null, complete: percent === 100 } : null,
  });
  // Booked (here or elsewhere): planning is the next step, so the planning sheet leads with it.
  const planningLeads = e.bookingSource === "external" || e.lifecycle === "booked" || e.lifecycle === "completed";

  return (
    <div data-plan-shell className="min-h-dvh bg-plan-canvas">
      <ClientHeader email={auth.user.email ?? null} back wide signOut={signOut} />
      <main style={brandStyle(live?.brandColors.primary)} className="mx-auto grid w-full max-w-5xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-8 sm:pt-8">
        <header className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-h-8 min-w-0 items-center text-sm">
              <BrandLogo logo={live?.logo ?? null} name={dj} className="max-h-9 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
            </span>
            <span data-testid="event-status" className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold", TONES[status.tone])}>
              {status.label}
            </span>
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

        {/* Two balanced columns when there are booking documents; otherwise one readable column. */}
        <div className={cn("grid items-start gap-4 sm:gap-6", facts.contract ? "lg:grid-cols-2" : "max-w-2xl")}>
          <div className="grid gap-4 sm:gap-6">
            {planningLeads ? <Planning facts={facts} step={step} dj={dj} /> : <NextStep step={step} />}
            {!planningLeads && facts.plan ? <Planning facts={facts} step={null} dj={dj} /> : null}
          </div>
          {facts.contract ? (
            <div className="grid gap-4 sm:gap-6">
              <Booking slug={slug} eventId={eventId} timezone={e.timezone} contract={facts.contract} />
              <ClientPayments
                terms={facts.contract}
                signed={facts.contract.signing.signed}
                payments={facts.payments}
                djName={dj}
                className={cn(SHEET, "[--muted-foreground:var(--plan-ink-2)]")}
                headingClassName="text-lg leading-snug font-semibold"
              />
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StepAction({ step }: { step: HubStep }) {
  if (!step.action) return null;
  // A jump to details further down this page: a quiet link on phones, nothing on desktop (they're in view).
  if (step.action.href.startsWith("#")) {
    return (
      <p className="lg:hidden">
        <a href={step.action.href} className={cn("rounded-sm text-sm font-medium underline underline-offset-4", FOCUS)}>
          {step.action.label}
        </a>
      </p>
    );
  }
  return (
    <div>
      <Link href={step.action.href} className={PRIMARY} data-testid="hub-primary">
        {step.action.label}
      </Link>
    </div>
  );
}

function NextStep({ step }: { step: HubStep }) {
  return (
    <section aria-labelledby="next-step-heading" className={SHEET} data-testid="hub-next-step">
      <div className="grid gap-1">
        <p className="text-sm text-plan-ink-2">Your next step</p>
        <h2 id="next-step-heading" className="text-lg leading-snug font-semibold text-balance">{step.title}</h2>
      </div>
      {step.text ? <p className="max-w-[60ch] text-sm text-pretty text-plan-ink-2">{step.text}</p> : null}
      <StepAction step={step} />
    </section>
  );
}

/** Planning: progress and the deadline when it's open, with the step leading when planning is what comes next. */
function Planning({ facts, step, dj }: { facts: ClientEventFacts; step: HubStep | null; dj: string }) {
  const plan = facts.plan;
  const action = step ?? (plan ? { title: "", text: null, action: { label: plan.editing?.state === "closed" ? "View your plan" : "Continue planning", href: `/${facts.home.tenantSlug}/planning/${facts.home.eventId}` } } : null);
  return (
    <section aria-labelledby="planning-heading" className={SHEET} data-testid="hub-planning">
      <div className="grid gap-1">
        <p className="text-sm text-plan-ink-2">Your planning</p>
        <h2 id="planning-heading" className="text-lg leading-snug font-semibold text-balance">{step?.title ?? "Planning"}</h2>
      </div>
      {step?.text ? <p className="max-w-[60ch] text-sm text-pretty text-plan-ink-2">{step.text}</p> : null}
      {plan?.progress ? <ProgressMeter progress={plan.progress} bar="bg-brand-ink" compact /> : null}
      {plan?.editing && plan.editing.state !== "closed" ? (
        <p className="text-sm text-plan-ink-2" data-testid="hub-deadline">{clientEditingText(plan.editing, dj)}</p>
      ) : null}
      {action ? <StepAction step={action} /> : null}
    </section>
  );
}

/** The signer's documents: the approved proposal, the contract and its signed PDF. */
function Booking({ slug, eventId, timezone, contract }: { slug: string; eventId: string; timezone: string; contract: NonNullable<ClientEventFacts["contract"]> }) {
  const signed = contract.signing.signed ? contract.signing : null;
  const row = cn("-mx-2 flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-plan-track/60", FOCUS);
  return (
    <section aria-labelledby="booking-heading" className={SHEET} data-testid="hub-booking">
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
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
          </Link>
        </li>
      </ul>
      {signed?.pdfReady ? (
        <div>
          <PdfDownloadLink
            className={cn("inline-flex min-h-11 items-center rounded-[10px] px-3 text-sm font-medium ring-1 ring-plan-hairline hover:bg-plan-track/60 max-sm:w-full max-sm:justify-center", FOCUS)}
            href={`/${slug}/contracts/${contract.id}/signed-pdf`}
            fallbackName="signed-contract.pdf"
          >
            Download signed PDF
          </PdfDownloadLink>
        </div>
      ) : signed?.pdfPending ? (
        <p className="text-sm text-plan-ink-2">Your signed PDF is being prepared.</p>
      ) : signed ? (
        <p className="text-sm text-plan-ink-2">Your signed PDF isn&apos;t available yet. The signed contract above is the agreement.</p>
      ) : null}
    </section>
  );
}

/** Any event this client can't open: one answer, naming nothing. */
function Unavailable({ email }: { email: string | null }) {
  return (
    <div data-plan-shell className="min-h-dvh bg-plan-canvas">
      <ClientHeader email={email} back signOut={signOut} />
      <main className="mx-auto grid w-full max-w-md px-4 py-12">
        <section className={SHEET}>
          <h1 className="text-xl font-semibold">This event isn&apos;t available</h1>
          <p className="text-sm text-plan-ink-2">
            It may no longer be active, or this account can&apos;t open it. If you think it should be available, contact your DJ.
          </p>
          <p className="text-sm">
            See <Link className="font-medium underline" href="/my">your events</Link>.
          </p>
        </section>
      </main>
    </div>
  );
}
