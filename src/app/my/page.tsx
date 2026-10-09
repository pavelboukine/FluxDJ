import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, MapPin } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { InstallHelp, PdfDownloadLink } from "@/components/app/pwa";
import { ClientHeader } from "@/components/app/client-header";
import { signOut } from "@/app/auth/confirm/actions";
import { requireUser } from "@/lib/auth/staff";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand, type BrandLogo as Logo } from "@/lib/branding/logo.server";
import { homeCard, splitByDate, type HomeAction, type HomeCard, type HomeEvent, type HomeTone } from "@/lib/client-home";
import { clientEditingSchema } from "@/lib/planning/cutoff";
import { formatEventDate } from "@/lib/planning/view";
import type { ClientPaymentSummary } from "@/lib/payments";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your events", robots: { index: false, follow: false } };

type Brand = { logo: Logo | null; primary: string | undefined };

/**
 * Client home after sign-in: the events this verified identity can open, each
 * with its own business's branding, status and one recommended next action.
 * Every fact comes from client views that check access in the database (see
 * lib/client-home); this page never reads staff data.
 */
export default async function MyEvents() {
  const { supabase, user } = await requireUser();
  const [{ data: events }, { data: contracts }, { data: plans }, { count: memberships }] = await Promise.all([
    supabase.rpc("my_events"),
    supabase.rpc("my_contracts"),
    supabase.rpc("my_plans"),
    supabase.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);

  // Readable contracts (signer only) per event, with their signing and PDF state and the booking/payment summary.
  const contractByEvent = new Map<string, { contract: HomeEvent["contract"]; payments: HomeEvent["payments"] }>();
  await Promise.all(
    (contracts ?? []).map(async (c) => {
      if (!c.event_id || contractByEvent.has(c.event_id)) return;
      const [{ data: view }, { data: summary }] = await Promise.all([
        supabase.rpc("client_contract_view", { p_contract_id: c.contract_id, p_tenant_slug: c.tenant_slug }),
        supabase.rpc("client_payment_summary", { p_contract_id: c.contract_id, p_tenant_slug: c.tenant_slug }),
      ]);
      const v = view as { state: string; signing?: { signed: boolean; enabled?: boolean; pdf_ready?: boolean; pdf_pending?: boolean } } | null;
      if (v?.state !== "available" || !v.signing) return;
      const s = summary as ClientPaymentSummary | null;
      contractByEvent.set(c.event_id, {
        contract: {
          id: c.contract_id,
          status: c.status === "signed" ? "signed" : "sent",
          signable: v.signing.signed || v.signing.enabled === true,
          pdfReady: v.signing.pdf_ready === true,
          pdfPending: v.signing.pdf_pending === true,
        },
        payments: s ? { currency: s.currency, bookingStatus: s.booking_status, depositOutstandingCents: s.deposit_outstanding_cents } : null,
      });
    }),
  );

  // Planning the database lets this client open, and whether editing is open.
  const planByEvent = new Map<string, HomeEvent["plan"]>();
  await Promise.all(
    (plans ?? []).map(async (p) => {
      const { data } = await supabase.rpc("client_planning_view", { p_event_id: p.event_id, p_tenant_slug: p.tenant_slug });
      const view = data as { state?: string; editing?: unknown } | null;
      if (view?.state !== "available") return;
      const editing = clientEditingSchema.safeParse(view.editing);
      planByEvent.set(p.event_id, { editing: editing.success ? editing.data.state : null });
    }),
  );

  const homeEvents: HomeEvent[] = (events ?? []).map((e) => ({
    eventId: e.event_id,
    tenantSlug: e.tenant_slug,
    tenantName: e.tenant_display_name,
    title: e.title,
    eventDate: e.event_date,
    timezone: e.timezone,
    venueName: e.venue_name || null,
    lifecycle: e.lifecycle_status,
    contract: contractByEvent.get(e.event_id)?.contract ?? null,
    payments: contractByEvent.get(e.event_id)?.payments ?? null,
    plan: planByEvent.get(e.event_id) ?? null,
  }));

  // Each business's current branding (after the access checks above), once per business.
  const brands = new Map<string, Brand>();
  await Promise.all(
    [...new Set(homeEvents.map((e) => e.tenantSlug))].map(async (slug) => {
      const live = await liveBrand(slug);
      brands.set(slug, { logo: live?.logo ?? null, primary: live?.brandColors.primary });
    }),
  );

  const { upcoming, past } = splitByDate(homeEvents, new Date());

  return (
    <div className="min-h-dvh bg-muted/40">
      <ClientHeader email={user.email ?? null} staffLink={memberships ? "/staff" : null} signOut={signOut} />
      <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:pt-10">
        <InstallHelp />
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your events</h1>
          <p className="text-sm text-muted-foreground">Contracts, payments and planning shared with you by your DJ.</p>
        </div>

        {homeEvents.length === 0 ? (
          <section className="grid gap-2 rounded-2xl border bg-card p-5 text-sm shadow-sm">
            <h2 className="text-base font-semibold">No events yet</h2>
            <p>{user.email} has no contracts to read yet. Your DJ will email you when one is ready.</p>
            <p className="text-muted-foreground">Proposals open from the link in your DJ&apos;s email; they don&apos;t need an account.</p>
          </section>
        ) : null}

        {upcoming.length > 0 ? (
          <section aria-labelledby="upcoming-heading" className="grid gap-3">
            <h2 id="upcoming-heading" className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              Upcoming
            </h2>
            <ul className="grid gap-4">
              {upcoming.map((e) => (
                <EventCard key={e.eventId} event={e} card={homeCard(e)} brand={brands.get(e.tenantSlug)} />
              ))}
            </ul>
          </section>
        ) : homeEvents.length > 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming events.</p>
        ) : null}

        {past.length > 0 ? (
          <details className="group/past grid gap-3" open={upcoming.length === 0}>
            <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              Past events ({past.length})
            </summary>
            <ul className="mt-3 grid gap-4">
              {past.map((e) => (
                <EventCard key={e.eventId} event={e} card={homeCard(e)} brand={brands.get(e.tenantSlug)} past />
              ))}
            </ul>
          </details>
        ) : null}
      </main>
    </div>
  );
}

const TONES: Record<HomeTone, string> = {
  action: "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100",
  waiting: "bg-muted text-foreground",
  done: "bg-emerald-100 text-emerald-950 dark:bg-emerald-500/20 dark:text-emerald-100",
  neutral: "bg-muted text-muted-foreground",
};

function EventCard({ event: e, card, brand, past }: { event: HomeEvent; card: HomeCard; brand: Brand | undefined; past?: boolean }) {
  return (
    <li style={brandStyle(brand?.primary)} className={cn("overflow-hidden rounded-2xl border bg-card", past ? "shadow-none" : "shadow-sm")}>
      <div aria-hidden className="h-1.5 bg-[var(--brand)]" />
      <div className="grid gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-h-8 min-w-0 items-center text-sm">
            <BrandLogo logo={brand?.logo ?? null} name={e.tenantName} className="max-h-8 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
          </span>
          <span data-testid="event-status" className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", TONES[card.tone])}>
            {card.status}
          </span>
        </div>
        <div className="grid gap-1">
          <h3 className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{e.title}</h3>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
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
        {card.note ? <p className="text-sm">{card.note}</p> : null}
        {e.contract?.status === "signed" && e.contract.pdfPending && !e.contract.pdfReady ? (
          <p className="text-xs text-muted-foreground">Your signed PDF is being prepared.</p>
        ) : null}
        {card.primary || card.secondary.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {card.primary ? <ActionLink action={card.primary} title={e.title} primary /> : null}
            {card.secondary.map((a) => (
              <ActionLink key={a.label} action={a} title={e.title} />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ActionLink({ action, title, primary }: { action: HomeAction; title: string; primary?: boolean }) {
  const className = primary
    ? "inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--brand-foreground)] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 max-sm:w-full"
    : "inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-md";
  // Several events can share a label, so the link's accessible name includes the event.
  const label = (
    <>
      {action.label}
      <span className="sr-only"> for {title}</span>
    </>
  );
  return action.kind === "pdf" ? (
    <PdfDownloadLink className={className} href={action.href} fallbackName="signed-contract.pdf">
      {label}
    </PdfDownloadLink>
  ) : (
    <Link className={className} href={action.href}>
      {label}
    </Link>
  );
}
