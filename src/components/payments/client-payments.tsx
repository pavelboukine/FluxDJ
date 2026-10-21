import type { ReactNode } from "react";
import { DiscountRows, InvoiceLink } from "@/components/payments/payment-summary";
import { formatCents } from "@/lib/money";
import { discountBreakdown, type ClientPaymentSummary } from "@/lib/payments";
import { formatEventDate } from "@/lib/planning/view";
import { cn } from "@/lib/utils";

/** A contract's frozen payment terms (client_contract_view). */
export type ContractTerms = {
  currency: string;
  totalCents: number;
  depositPercent: number;
  depositCents: number;
  balanceCents: number;
  balanceDueDate: string | null;
};

function Row({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "font-semibold")}>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The signer's payments: the contract's frozen terms, then what the business
 * has recorded (client_payment_summary). Shared by the contract page and the
 * event hub; it shows figures, never computes them, and never offers to take
 * a payment (Flux DJ takes none). A $0 contract says "No payment due".
 */
export function ClientPayments({
  terms,
  signed,
  payments,
  djName,
  className,
  headingClassName = "text-base font-semibold",
}: {
  terms: ContractTerms;
  signed: boolean;
  payments: ClientPaymentSummary | null;
  djName: string;
  className?: string;
  headingClassName?: string;
}) {
  const money = (cents: number) => formatCents(cents, terms.currency);
  // This contract's frozen breakdown, only when its proposal had a discount.
  const discount = discountBreakdown(payments?.pricing ?? null);
  const free = terms.totalCents === 0;
  return (
    <section id="payments" aria-labelledby="payments-heading" className={cn("grid scroll-mt-4 gap-3 text-sm", className)}>
      <h2 id="payments-heading" className={headingClassName}>
        Payments
      </h2>
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">{signed ? "Agreed terms" : "Terms in this contract"}</p>
        <p className="text-muted-foreground">{signed ? "Terms of the signed contract. They don't change." : "Terms of the contract sent to you. It isn't signed yet."}</p>
        <dl className="grid gap-1">
          {discount ? <DiscountRows b={discount} currency={terms.currency} /> : null}
          <Row label={discount ? "Agreed total, including taxes" : "Total, including taxes"} strong>{money(terms.totalCents)}</Row>
          {free ? (
            <Row label="Payment">No payment due</Row>
          ) : (
            <>
              <Row label={`Deposit on signing (${terms.depositPercent}%)`}>{terms.depositCents ? money(terms.depositCents) : "No deposit required"}</Row>
              <Row label="Balance">{money(terms.balanceCents)}</Row>
              <Row label="Balance due">{terms.balanceDueDate ? formatEventDate(terms.balanceDueDate) : "Not specified in the contract"}</Row>
            </>
          )}
        </dl>
      </div>
      {payments && !free ? (
        <div className="grid gap-1.5 border-t pt-3">
          <p className="text-sm font-medium">Recorded by {djName}</p>
          <dl className="grid gap-1">
            <Row label="Received so far" strong>{formatCents(payments.received_cents, payments.currency)}</Row>
            {payments.deposit_cents ? (
              payments.deposit_outstanding_cents ? (
                <Row label="Deposit still outstanding">{formatCents(payments.deposit_outstanding_cents, payments.currency)}</Row>
              ) : (
                <Row label="Deposit">Received in full</Row>
              )
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
            Payments are recorded by hand by {djName} when they receive them, so a recent payment may not appear yet. Pay only as arranged with {djName};
            Flux DJ doesn&apos;t take payments.
          </p>
        </div>
      ) : null}
    </section>
  );
}
