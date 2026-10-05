import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import { InvoiceLink, PaymentFigures } from "@/components/payments/payment-summary";
import type { StaffContext } from "@/lib/auth/staff";
import { formatCents } from "@/lib/money";
import { todayIn, type PaymentSummary } from "@/lib/payments";
import { recordPayment, saveInvoiceUrl } from "../payment-actions";
import { CheckBooking } from "./check-booking";
import { InvalidatePayment } from "./invalidate-payment";
import { RecordPaymentForm } from "./record-payment-form";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/**
 * Payments received outside Flux DJ, recorded by staff: the summary against
 * the authoritative contract terms, the full history (including invalidated
 * entries), recording, invalidation and the optional invoice link. Staff only.
 */
export async function PaymentsCard({ staff, slug, eventId, archived }: { staff: StaffContext; slug: string; eventId: string; archived: boolean }) {
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
  const s = summaryData as PaymentSummary | null;
  if (!s) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>
          Payments received elsewhere (Wave, e-transfer, cash…), recorded here by hand. Flux DJ doesn&apos;t process or verify payments.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <BookingState slug={slug} eventId={eventId} s={s} archived={archived} />
        <section aria-label="Payment summary" className="grid gap-2">
          <PaymentFigures
            audience="staff"
            s={{
              currency: s.currency,
              termsStatus: s.terms?.status ?? null,
              totalCents: s.terms?.total_cents ?? null,
              depositPercent: s.terms?.deposit_percent ?? null,
              depositCents: s.terms?.deposit_cents ?? null,
              balanceDueDate: s.terms?.balance_due_date ?? null,
              receivedCents: s.received_cents,
              depositOutstandingCents: s.deposit_outstanding_cents,
              remainingBalanceCents: s.remaining_balance_cents,
              creditCents: s.credit_cents,
            }}
          />
          {s.other_currency_payments > 0 ? (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
              {s.other_currency_payments} payment(s) in another currency aren&apos;t included in these totals.
            </p>
          ) : null}
        </section>

        <section aria-label="Invoice link" className="grid gap-2">
          {billing?.invoice_url ? <p className="text-sm">Invoice: <InvoiceLink url={billing.invoice_url} /></p> : null}
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

        {archived ? (
          <p role="status" className="text-sm text-muted-foreground">Unarchive the event to record or correct payments.</p>
        ) : (
          <section aria-label="Record a payment" className="grid gap-2">
            <h3 className="text-sm font-medium">Record a payment</h3>
            <p className="text-xs text-muted-foreground">
              Once the contract is signed, a payment that brings the total received up to the required deposit confirms the booking
              automatically (when the contract&apos;s policy asks for the deposit) and emails the client a booking confirmation.
            </p>
            <RecordPaymentForm action={recordPayment.bind(null, slug, eventId)} today={todayIn(tenant.timezone)} currency={tenant.currency} />
          </section>
        )}

        <section aria-label="Payment history" className="grid gap-2">
          <h3 className="text-sm font-medium">History</h3>
          {(payments ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No payments recorded yet.</p> : null}
          <ul className="grid gap-2">
            {(payments ?? []).map((p) => {
              const amount = formatCents(p.amount_cents, p.currency);
              return (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm">
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
      </CardContent>
    </Card>
  );
}

const POLICY_TEXT = { on_deposit: "when signed and the deposit is received", on_signature: "when signed" } as const;

/** The booking state, decided in the database from the signed contract's frozen policy and valid payments. */
function BookingState({ slug, eventId, s, archived }: { slug: string; eventId: string; s: PaymentSummary; archived: boolean }) {
  const b = s.booking;
  const money = (cents: number) => formatCents(cents, s.currency);
  if (b.lifecycle_status === "booked") {
    return (
      <section aria-label="Booking" className="grid gap-1 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm">
        <p className="font-medium">Booked · confirmed {b.booking_confirmed_at ? fmt(b.booking_confirmed_at) : ""}</p>
        <p className="text-muted-foreground">
          {b.policy ? `This contract confirms the booking ${POLICY_TEXT[b.policy]}.` : "Confirmed by a booking check (signed and deposit received)."}{" "}
          {s.remaining_balance_cents ? `${money(s.remaining_balance_cents)} is still to be paid.` : null}
        </p>
        {b.deposit_no_longer_met ? (
          <p role="alert" className="font-medium text-amber-700 dark:text-amber-400">
            The booking stands, but valid payments no longer cover the required deposit
            {s.deposit_outstanding_cents ? ` (${money(s.deposit_outstanding_cents)} short)` : ""}. Nothing was cancelled; follow up with
            the client if needed.
          </p>
        ) : null}
      </section>
    );
  }
  if (b.lifecycle_status === "awaiting_deposit") {
    return (
      <section aria-label="Booking" className="grid gap-1 rounded-lg border p-3 text-sm">
        <p className="font-medium">Signed · awaiting deposit</p>
        <p className="text-muted-foreground">
          The booking is confirmed automatically once valid payments reach the required deposit
          {s.deposit_outstanding_cents ? ` (${money(s.deposit_outstanding_cents)} still outstanding)` : ""}.
        </p>
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
      Not booked. Once the contract is signed, the booking is confirmed automatically according to the booking policy it was generated
      with.
    </section>
  );
}
