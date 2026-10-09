import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CalendarDays, CheckCircle2, Clock, FileText, Lock, MapPin, PenLine } from "lucide-react";
import { PdfDownloadLink } from "@/components/app/pwa";
import { BrandLogo } from "@/components/app/brand-logo";
import { ClientHeader } from "@/components/app/client-header";
import { ContractDocument } from "@/components/contract/contract-document";
import { InvoiceLink } from "@/components/payments/payment-summary";
import { signOut } from "@/app/auth/confirm/actions";
import { renderedContentSchema } from "@/lib/contracts/content";
import { SIGNATURE_BUCKET } from "@/lib/contracts/signing";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import type { ClientPaymentSummary } from "@/lib/payments";
import { formatEventDate } from "@/lib/planning/view";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { SignPanel } from "./sign-panel";

export const metadata: Metadata = { title: "Your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

type View =
  | { state: "unavailable" }
  | {
      state: "available";
      brand: { display_name: string; brand_colors: { primary?: string; accent?: string } };
      contract: {
        id: string; status: "sent" | "signed"; sent_at: string; content_sha256: string; rendered_content: unknown; signer_name: string; currency: string;
        total_cents: number; deposit_percent: number; deposit_cents: number; balance_cents: number; balance_due_date: string | null;
        signing_mode: "demo" | "client_use" | "none";
        event_title: string; event_date: string; legal_name: string;
      };
      signing:
        | { signed: true; typed_name: string; signed_at: string; pdf_ready: boolean; pdf_pending: boolean }
        | { signed: false; enabled: boolean; consent_version: string | null; consent_text: string | null };
    };

function Notice({ title, icon: Icon, email, children }: { title: string; icon: typeof Lock; email?: string | null; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-muted/40">
      <ClientHeader email={email ?? null} back={email !== undefined} signOut={email ? signOut : undefined} />
      <main className="mx-auto grid w-full max-w-md px-4 py-12">
        <div className="grid gap-3 rounded-2xl border bg-card p-6 text-sm shadow-sm">
          <Icon aria-hidden className="size-7 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

/** "October 9, 2026 at 3:12 p.m. EDT" in the event's time zone (or the viewer's when unknown). */
function formatInstant(iso: string, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short", timeZone, timeZoneName: "short" }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));
  }
}

function Row({ label, children, strong }: { label: React.ReactNode; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "font-semibold")}>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The client's contract. Every request is checked in the database: verified
 * identity, event access, intended signer, and that the contract is still
 * sent and current (or signed) and not archived or suspended. Only frozen
 * contract data and the client payment summary are shown; nothing here
 * computes money, booking or planning state.
 */
export default async function ClientContractPage({ params }: PageProps<"/[tenant]/contracts/[contractId]">) {
  const { tenant: slug, contractId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(contractId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <Notice title="Sign in to read your contract" icon={Lock}>
        <p>Your contract is private. Sign in with the email address your DJ sent it to.</p>
        <Link className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground" href="/login">
          Sign in with your email
        </Link>
      </Notice>
    );
  }
  const { data } = await supabase.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: slug });
  const view = (data as View | null) ?? { state: "unavailable" };
  if (view.state !== "available") {
    return (
      <Notice title="This contract isn't available" icon={FileText} email={auth.user.email ?? null}>
        <p>It may have been replaced or cancelled, the event may no longer be available online, or this account can&apos;t open it.</p>
        <p>Use the most recent email from your DJ, or see <Link className="font-medium underline" href="/my">your events</Link>.</p>
      </Notice>
    );
  }

  const c = view.contract;
  const content = renderedContentSchema.parse(c.rendered_content);
  const money = (cents: number) => formatCents(cents, c.currency);
  const dj = view.brand.display_name;
  // Live branding (current logo and colour), shown only after the access check above.
  const live = await liveBrand(slug);
  const pageStyle = brandStyle(view.brand.brand_colors.primary);
  // From the contract's frozen signing mode, never from its wording.
  const isDemo = c.signing_mode === "demo";
  const signing = view.signing;
  // Read-only client views, for the same verified access as the contract itself.
  const [{ data: paymentData }, { data: plans }, { data: mine }, { data: events }] = await Promise.all([
    supabase.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: slug }),
    signing.signed ? supabase.rpc("my_plans") : Promise.resolve({ data: [] }),
    supabase.rpc("my_contracts"),
    supabase.rpc("my_events"),
  ]);
  const payments = paymentData as ClientPaymentSummary | null;
  // Planning opens once the booking is confirmed; the database decides.
  const plan = (plans ?? []).find((p) => p.contract_id === contractId);
  // The event's venue and time zone, from the client's own event list.
  const eventId = (mine ?? []).find((m) => m.contract_id === contractId)?.event_id;
  const event = (events ?? []).find((e) => e.event_id === eventId);
  let signatureUrl: string | null = null;
  if (signing.signed) {
    // Authorized in the database for this signer only; the link lasts two minutes.
    const { data: path } = await supabase.rpc("client_signature_object", { p_contract_id: contractId, p_tenant_slug: slug });
    if (path) signatureUrl = (await createAdminClient().storage.from(SIGNATURE_BUCKET).createSignedUrl(path, 120)).data?.signedUrl ?? null;
  }

  const status = signing.signed
    ? payments?.booking_status === "booked"
      ? { label: "Signed · booked", tone: "done" as const }
      : payments?.booking_status === "awaiting_deposit"
        ? { label: "Signed · awaiting deposit", tone: "waiting" as const }
        : { label: "Signed", tone: "done" as const }
    : signing.enabled
      ? { label: "Ready to sign", tone: "action" as const }
      : { label: "Not available for online signing", tone: "waiting" as const };
  const tones = {
    action: "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100",
    waiting: "bg-muted text-foreground",
    done: "bg-emerald-100 text-emerald-950 dark:bg-emerald-500/20 dark:text-emerald-100",
  };
  const canSign = !signing.signed && signing.enabled && signing.consent_version && signing.consent_text;

  const paymentsCard = (
    <section id="payments" aria-labelledby="payments-heading" className="grid scroll-mt-4 gap-3 rounded-2xl border bg-card p-4 text-sm shadow-sm sm:p-6">
      <h2 id="payments-heading" className="text-base font-semibold">
        Payments
      </h2>
      <div className="grid gap-1.5">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{signing.signed ? "Agreed terms" : "Terms in this contract"}</p>
        <p className="text-muted-foreground">{signing.signed ? "Terms of the signed contract. They don't change." : "Terms of the contract sent to you. It isn't signed yet."}</p>
        <dl className="grid gap-1">
          <Row label="Total, including taxes" strong>{money(c.total_cents)}</Row>
          <Row label={`Deposit on signing (${c.deposit_percent}%)`}>{c.deposit_cents ? money(c.deposit_cents) : "No deposit required"}</Row>
          <Row label="Balance">{money(c.balance_cents)}</Row>
          <Row label="Balance due">{c.balance_due_date ? formatEventDate(c.balance_due_date) : "Not specified in the contract"}</Row>
        </dl>
      </div>
      {payments ? (
        <div className="grid gap-1.5 border-t pt-3">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recorded by {dj}</p>
          <dl className="grid gap-1">
            <Row label="Received so far" strong>{formatCents(payments.received_cents, payments.currency)}</Row>
            {payments.deposit_cents ? (
              <Row label="Deposit still outstanding">
                {payments.deposit_outstanding_cents ? formatCents(payments.deposit_outstanding_cents, payments.currency) : "Deposit received in full"}
              </Row>
            ) : null}
            {payments.remaining_balance_cents !== null ? (
              <Row label="Remaining balance" strong>{payments.remaining_balance_cents ? formatCents(payments.remaining_balance_cents, payments.currency) : "Paid in full"}</Row>
            ) : null}
            {payments.credit_cents ? <Row label="Received above the total (credit)">{formatCents(payments.credit_cents, payments.currency)}</Row> : null}
          </dl>
          {payments.invoice_url ? (
            <p>
              <InvoiceLink url={payments.invoice_url} />
              <span className="text-muted-foreground"> · opens the invoice on that site</span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Payments are recorded by hand by {dj} when they receive them, so a recent payment may not appear yet. Pay only as arranged with {dj};
            Flux DJ doesn&apos;t take payments.
          </p>
        </div>
      ) : null}
    </section>
  );

  return (
    <div className="min-h-dvh bg-muted/40">
      <ClientHeader email={auth.user.email ?? null} back signOut={signOut} />
      <main style={pageStyle} className="mx-auto grid w-full max-w-3xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-6 sm:pt-8">
        {isDemo ? (
          <p role="alert" className="rounded-xl border-2 border-destructive bg-card p-3 text-sm font-semibold text-destructive">
            DEMO, NOT FOR CLIENT USE. This is test wording, not a real agreement.
          </p>
        ) : null}

        <section aria-label="Contract overview" className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div aria-hidden className="h-1.5 bg-[var(--brand)]" />
          <div className="grid gap-4 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-h-8 min-w-0 items-center text-sm">
                <BrandLogo logo={live?.logo ?? null} name={dj} className="max-h-10 max-w-40" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
              </span>
              <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", tones[status.tone])}>{status.label}</span>
            </div>
            <div className="grid gap-1.5">
              <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{content.title}</h1>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground [overflow-wrap:anywhere]">{c.event_title}</span>
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays aria-hidden className="size-4 shrink-0" />
                  {/^\d{4}-\d{2}-\d{2}$/.test(c.event_date) ? formatEventDate(c.event_date) : c.event_date}
                </span>
                {event?.venue_name ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
                    <MapPin aria-hidden className="size-4 shrink-0" />
                    {event.venue_name}
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">Sent by {dj} on {formatInstant(c.sent_at, event?.timezone).replace(/ at .*/, "")}</p>
            </div>
            {!signing.signed ? (
              signing.enabled ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 p-3 text-sm">
                  <p>
                    <span className="font-medium">Next:</span> read the agreement and payment terms, then sign at the end of this page.
                  </p>
                  {canSign ? (
                    <a href="#sign" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[var(--brand)] px-4 font-semibold text-[var(--brand-foreground)] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 max-sm:w-full max-sm:justify-center">
                      <PenLine aria-hidden className="size-4" />
                      Go to signing
                    </a>
                  ) : null}
                </div>
              ) : (
                <p role="status" className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                  Please read your contract. It can&apos;t be signed online; {dj} will send you an updated contract to sign.
                </p>
              )
            ) : null}
          </div>
        </section>

        {signing.signed ? (
          <section role="status" aria-labelledby="signed-heading" className="grid gap-3 rounded-2xl border-2 border-emerald-600 bg-card p-4 text-sm shadow-sm sm:p-6">
            <div className="flex items-center gap-2">
              <CheckCircle2 aria-hidden className="size-6 shrink-0 text-emerald-600" />
              <h2 id="signed-heading" className="text-lg font-semibold">
                Contract signed.
              </h2>
            </div>
            <p className="text-muted-foreground">
              {/* en-CA times end in "p.m.", so no extra full stop is added. */}
              Signed by {signing.typed_name} on {formatInstant(signing.signed_at, event?.timezone).replace(/\.?$/, ".")}
            </p>
            {signatureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimizable asset
              <img src={signatureUrl} alt={`Signature of ${signing.typed_name}`} className="h-20 w-auto max-w-full self-start rounded-lg border bg-white" />
            ) : null}
            <div className="grid gap-1 text-base">
              {payments?.booking_status === "booked" ? (
                <p className="font-medium">Your booking is confirmed.</p>
              ) : payments?.booking_status === "awaiting_deposit" ? (
                <p>
                  Your booking will be confirmed once {dj} has recorded your deposit
                  {payments.deposit_outstanding_cents ? ` (${formatCents(payments.deposit_outstanding_cents, payments.currency)} still to pay)` : ""}.{" "}
                  <a className="text-sm font-medium underline" href="#payments">
                    Deposit details
                  </a>
                </p>
              ) : null}
              {plan ? (
                <p>
                  <Link className="font-medium underline" href={`/${slug}/planning/${plan.event_id}`}>
                    Plan your event
                  </Link>
                  : event basics now, with more sections to come.
                </p>
              ) : (
                <p>Your DJ will follow up with the next steps.</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              {signing.pdf_ready ? (
                <PdfDownloadLink
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--brand-foreground)] outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
                  href={`/${slug}/contracts/${contractId}/signed-pdf`}
                  fallbackName="signed-contract.pdf"
                >
                  Download signed PDF
                </PdfDownloadLink>
              ) : signing.pdf_pending ? (
                <p data-testid="pdf-preparing" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Clock aria-hidden className="size-4" />
                  Your signed PDF is being prepared. Reload this page in a minute to download it.
                  <Link className="font-medium text-foreground underline" href={`/${slug}/contracts/${contractId}`}>
                    Reload
                  </Link>
                </p>
              ) : (
                <p data-testid="pdf-unavailable" className="flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  Your signed PDF isn&apos;t ready yet. It&apos;s prepared automatically; if it doesn&apos;t appear later today, contact {dj}. The
                  contract on this page is the signed agreement.
                </p>
              )}
            </div>
          </section>
        ) : null}

        {signing.signed ? paymentsCard : null}

        <section aria-labelledby="agreement-heading" className="grid gap-4 rounded-2xl border bg-card px-4 py-5 shadow-sm sm:px-8 sm:py-8">
          {/* Same font size as the agreement, so both share one reading width. */}
          <div className="mx-auto grid w-full max-w-prose gap-4 text-base">
            <h2 id="agreement-heading" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              The agreement
            </h2>
            <ContractDocument title={content.title} sections={content.sections} headingLevel={2} showTitle={false} label={content.title} />
          </div>
        </section>

        {signing.signed ? null : paymentsCard}

        {canSign ? (
          <SignPanel
            slug={slug}
            contractId={c.id}
            contentSha256={c.content_sha256}
            consentVersion={signing.consent_version!}
            consentText={signing.consent_text!}
            isDemo={isDemo}
            expectedName={c.signer_name}
          />
        ) : null}

        <p className="mx-auto max-w-prose text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {c.legal_name} · Contract fingerprint (SHA-256): {c.content_sha256}
        </p>
      </main>
    </div>
  );
}
