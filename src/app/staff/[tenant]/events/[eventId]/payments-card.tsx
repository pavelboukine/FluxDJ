import { AlertTriangle, CircleCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { TextField } from "@/components/app/fields";
import { InvoiceLink, PaymentFigures } from "@/components/payments/payment-summary";
import type { StaffContext } from "@/lib/auth/staff";
import { shortDate, shortInstant } from "@/lib/dates";
import { paymentOverview } from "@/lib/events/workspace";
import { formatCents } from "@/lib/money";
import { discountBreakdown, readPaymentSummary, todayIn, type PaymentSummary } from "@/lib/payments";
import { recordPayment, saveInvoiceUrl } from "../payment-actions";
import { CheckBooking } from "./check-booking";
import { InvalidatePayment } from "./invalidate-payment";
import { RecordPaymentForm } from "./record-payment-form";

export type PaymentRow = {
  id: string;
  amount_cents: number;
  currency: string;
  paid_on: string;
  reference: string | null;
  note: string | null;
  recorded_by_email: string | null;
  created_at: string;
  invalidated_at: string | null;
  invalidated_by_email: string | null;
  invalidation_reason: string | null;
};

/** Everything the payments section shows, read once by the event page. */
export async function loadPayments(staff: StaffContext, eventId: string) {
  const { supabase, tenant } = staff;
  const [{ data: summaryData }, { data: payments }, { data: billing }] = await Promise.all([
    supabase.rpc("event_payment_summary", { p_event_id: eventId }),
    supabase
      .from("event_payments")
      .select("id, amount_cents, currency, paid_on, reference, note, recorded_by_email, created_at, invalidated_at, invalidated_by_email, invalidation_reason")
      .eq("tenant_id", tenant.id)
      .eq("event_id", eventId)
      .order("paid_on", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase.from("event_billing").select("invoice_url, version").eq("tenant_id", tenant.id).eq("event_id", eventId).maybeSingle(),
  ]);
  // Null when it can't be read or fails validation (logged): no figures rather than wrong ones.
  const summary = readPaymentSummary(summaryData, "event_payment_summary");
  // The contract's frozen proposal discount, if any (the terms' total already includes it).
  const { data: terms } = summary?.terms
    ? await supabase.from("contracts").select("commercial_snapshot").eq("tenant_id", tenant.id).eq("id", summary.terms.contract_id).maybeSingle()
    : { data: null };
  const discount = discountBreakdown(terms?.commercial_snapshot ?? null);
  return { summary, payments: (payments ?? []) as PaymentRow[], billing: billing ?? null, discount };
}

/**
 * Payments received outside Flux DJ, recorded by staff: the booking state
 * (from the database), the total, received and remaining balance against the
 * authoritative contract terms with what is owed next, and the warnings, all
 * visible; then recording a payment, the history (including invalidated
 * entries), the full terms and the invoice link behind disclosures. Staff only.
 */
export function PaymentsCard({
  staff,
  slug,
  eventId,
  archived,
  data,
  recordOpen,
  timeZone,
}: {
  staff: StaffContext;
  slug: string;
  eventId: string;
  archived: boolean;
  data: Awaited<ReturnType<typeof loadPayments>>;
  /** Open the record form at once (the event is waiting for its deposit). */
  recordOpen: boolean;
  /** The event's time zone: when payments were recorded and the booking confirmed. */
  timeZone: string;
}) {
  const { tenant } = staff;
  const { summary: s, payments, billing } = data;
  const fmt = (iso: string) => shortInstant(iso, timeZone);
  const overview = paymentOverview(s);
  if (!s || !overview) return null;
  const latest = payments.find((p) => !p.invalidated_at) ?? null;
  const flush = "rounded-none border-0 border-t";

  return (
    <Card id="payments" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Payments</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <BookingState slug={slug} eventId={eventId} s={s} archived={archived} fmt={fmt} />
        <section aria-label="Payment overview" className="grid gap-2 text-sm">
          {overview.figures ? (
            <>
              {s.terms?.status === "sent" ? <p className="text-xs text-muted-foreground">Sent contract terms, not signed yet</p> : null}
              <dl className="grid grid-cols-3 gap-x-3 gap-y-2" data-testid="payment-figures">
                {overview.figures.map((f) => (
                  <div key={f.label} className="grid min-w-0 gap-0.5">
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="text-base font-semibold tabular-nums [overflow-wrap:anywhere]">{f.value}</dd>
                  </div>
                ))}
              </dl>
              {overview.next ? <p className="font-medium" data-testid="payment-next">{overview.next}</p> : null}
            </>
          ) : s.no_financial_terms ? (
            <p className="text-muted-foreground" data-testid="payments-no-terms">
              No payment terms are recorded for this contract, so there is no total or deposit to compare.
              {s.received_cents ? ` ${formatCents(s.received_cents, s.currency)} received so far.` : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">
              No contract has been sent yet, so there is no total or deposit to compare.
              {s.received_cents ? ` ${formatCents(s.received_cents, s.currency)} received so far.` : ""}
            </p>
          )}
          {s.other_currency_payments > 0 ? (
            <p role="status" className="flex gap-1.5 text-amber-800 dark:text-amber-300">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {s.other_currency_payments} payment(s) in another currency aren&apos;t included in these totals.
            </p>
          ) : null}
          {billing?.invoice_url ? <p>Invoice: <InvoiceLink url={billing.invoice_url} /></p> : null}
        </section>

        {archived ? (
          <p role="status" className="text-sm text-muted-foreground">Unarchive the event to record or correct payments.</p>
        ) : (
          <Disclosure id="record-payment" summary="Record a payment" defaultOpen={recordOpen}>
            <section aria-label="Record a payment" className="grid gap-2">
              <p className="text-xs text-muted-foreground">
                For payments received outside Flux DJ (e-transfer, cash…).
                {s.booking.lifecycle_status === "booked"
                  ? ""
                  : s.booking.lifecycle_status === "awaiting_deposit"
                    ? " The one that reaches the deposit also emails the client their booking confirmation."
                    : s.no_financial_terms
                      ? ""
                      : " Once the contract is signed, the payment that reaches the required deposit confirms the booking and emails the client."}
              </p>
              <RecordPaymentForm action={recordPayment.bind(null, slug, eventId)} today={todayIn(tenant.timezone)} currency={tenant.currency} />
            </section>
          </Disclosure>
        )}

        <div className="-mx-4 -mb-4 grid">
          <Disclosure
            id="payment-history"
            summary={payments.length > 0 ? `Payment history (${payments.length})` : "Payment history"}
            hint={latest ? `Last: ${formatCents(latest.amount_cents, latest.currency)}, ${shortDate(latest.paid_on)}` : payments.length === 0 ? "None yet" : undefined}
            className={flush}
          >
            <section aria-label="Payment history" className="grid gap-2">
              {payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments recorded yet.</p> : null}
              <ul className="grid divide-y text-sm">
                {payments.map((p) => {
                  const amount = formatCents(p.amount_cents, p.currency);
                  return (
                    <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="grid gap-0.5">
                        <p className={p.invalidated_at ? "font-medium text-muted-foreground line-through" : "font-medium"}>
                          {amount} received {p.paid_on}
                        </p>
                        {p.reference ? <p>Reference: {p.reference}</p> : null}
                        {p.note ? <p className="whitespace-pre-line text-muted-foreground">{p.note}</p> : null}
                        <p className="text-xs text-muted-foreground">Recorded {fmt(p.created_at)} by {p.recorded_by_email ?? "a staff member"}</p>
                        {p.invalidated_at ? (
                          <p className="text-xs">
                            <span className="font-medium">Invalidated</span> {fmt(p.invalidated_at)} by {p.invalidated_by_email ?? "a staff member"}: {p.invalidation_reason}
                          </p>
                        ) : null}
                      </div>
                      {!p.invalidated_at && !archived ? (
                        <InvalidatePayment slug={slug} eventId={eventId} paymentId={p.id} label={`the payment of ${amount} received ${p.paid_on}`} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          </Disclosure>
          {s.terms ? (
            <Disclosure id="payment-terms" summary="Payment terms" hint={s.terms.deposit_cents ? (s.terms.deposit_percent === null ? "Deposit" : `Deposit ${s.terms.deposit_percent}%`) : "No deposit"} className={flush}>
              <section aria-label="Payment summary">
                <PaymentFigures
                  audience="staff"
                  s={{
                    currency: s.currency,
                    termsStatus: s.terms.status,
                    totalCents: s.terms.total_cents,
                    depositPercent: s.terms.deposit_percent,
                    depositCents: s.terms.deposit_cents,
                    balanceDueDate: s.terms.balance_due_date,
                    receivedCents: s.received_cents,
                    depositOutstandingCents: s.deposit_outstanding_cents,
                    remainingBalanceCents: s.remaining_balance_cents,
                    creditCents: s.credit_cents,
                    discount: data.discount,
                  }}
                />
              </section>
            </Disclosure>
          ) : null}
          <Disclosure id="invoice-link" summary="Invoice link" hint={billing?.invoice_url ? "Added" : "None"} className={flush}>
            <section aria-label="Invoice link" className="grid gap-2">
              <ActionForm action={saveInvoiceUrl.bind(null, slug, eventId)} version={billing?.version ?? 0} submitLabel="Save invoice link" trackUnsaved>
                <TextField
                  label="External invoice link (optional)"
                  name="invoice_url"
                  type="url"
                  inputMode="url"
                  maxLength={2000}
                  defaultValue={billing?.invoice_url ?? ""}
                  placeholder="https://"
                  hint="An https:// link from any invoicing tool. The client sees it with their payment summary. Flux DJ never opens it. Leave empty to remove it."
                />
              </ActionForm>
            </section>
          </Disclosure>
        </div>
      </CardContent>
    </Card>
  );
}

/** The booking state, decided in the database from the signed contract's frozen policy and valid payments: one line, plus anything to act on. */
function BookingState({ slug, eventId, s, archived, fmt }: { slug: string; eventId: string; s: PaymentSummary; archived: boolean; fmt: (iso: string) => string }) {
  const b = s.booking;
  const money = (cents: number) => formatCents(cents, s.currency);
  if (b.lifecycle_status === "booked") {
    return (
      <section aria-label="Booking" className="grid gap-1.5 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-300">
          <CircleCheck aria-hidden className="size-4 shrink-0" />
          Booked · confirmed {b.booking_confirmed_at ? fmt(b.booking_confirmed_at) : ""}
        </p>
        {b.deposit_no_longer_met ? (
          <p role="alert" className="flex gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              The booking stands, but valid payments no longer cover the required deposit
              {s.deposit_outstanding_cents ? ` (${money(s.deposit_outstanding_cents)} short)` : ""}. Nothing was cancelled; follow up with the
              client if needed.
            </span>
          </p>
        ) : null}
      </section>
    );
  }
  if (b.lifecycle_status === "awaiting_deposit") {
    return (
      <section aria-label="Booking" className="grid gap-1 text-sm">
        <p className="font-medium">Signed · awaiting deposit</p>
        <p className="text-muted-foreground">The booking is confirmed automatically once valid payments reach the required deposit.</p>
        {b.legacy_signed && !archived ? <CheckBooking slug={slug} eventId={eventId} /> : null}
      </section>
    );
  }
  if (b.legacy_signed) {
    return (
      <section aria-label="Booking" className="grid gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
        <p className="font-medium">Contract signed · booking not checked yet</p>
        <p>
          This contract was signed before booking policies existed, so it isn&apos;t confirmed automatically. Check booking confirms it if
          the required deposit has been received; otherwise the event waits for the deposit and is confirmed once payments cover it.
        </p>
        {archived ? <p className="text-muted-foreground">Unarchive the event to check its booking.</p> : <CheckBooking slug={slug} eventId={eventId} />}
      </section>
    );
  }
  return (
    <section aria-label="Booking" className="text-sm text-muted-foreground">
      {/* Before any contract terms, the overview below already says there is nothing to compare yet. */}
      {s.terms || s.no_financial_terms ? "Not booked. Once the contract is signed, the booking is confirmed automatically by the booking policy it was generated with." : "Not booked yet."}
    </section>
  );
}
