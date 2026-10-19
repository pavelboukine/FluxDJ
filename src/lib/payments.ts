import { discountDescription } from "@/lib/pricing/discount";

/**
 * Manual payment tracking. Payments are received elsewhere (Wave, e-transfer,
 * cash...) and recorded by staff; Flux DJ never processes or verifies them.
 * Totals are computed only in the database (private.event_payment_summary)
 * from the event's authoritative contract; this module only describes them.
 */

/** private.event_payment_summary, as staff receive it. */
export type PaymentSummary = {
  currency: string;
  terms: {
    status: "signed" | "sent";
    contract_id: string;
    total_cents: number;
    deposit_percent: number;
    deposit_cents: number;
    balance_cents: number;
    balance_due_date: string | null;
  } | null;
  received_cents: number;
  valid_payments: number;
  other_currency_payments: number;
  deposit_outstanding_cents: number | null;
  remaining_balance_cents: number | null;
  credit_cents: number | null;
  invoice_url: string | null;
  booking: {
    lifecycle_status: string;
    booking_confirmed_at: string | null;
    /** The signed contract's frozen policy; null before signing or for legacy contracts. */
    policy: "on_deposit" | "on_signature" | null;
    /** Signed before booking policies existed: staff check it explicitly. */
    legacy_signed: boolean;
    /** Booked under the deposit policy, but valid payments no longer cover the deposit. */
    deposit_no_longer_met: boolean;
  };
};

/** client_payment_summary: only what the client may see. */
export type ClientPaymentSummary = {
  currency: string;
  terms_status: "signed" | "sent" | null;
  total_cents: number | null;
  deposit_percent: number | null;
  deposit_cents: number | null;
  balance_due_date: string | null;
  received_cents: number;
  deposit_outstanding_cents: number | null;
  remaining_balance_cents: number | null;
  credit_cents: number | null;
  invoice_url: string | null;
  booking_status: "booked" | "awaiting_deposit" | null;
  /** Only for a contract generated from a discounted proposal: its frozen price breakdown (see discountBreakdown). */
  pricing?: unknown;
};

/**
 * A discounted contract's frozen price breakdown, as shown with its payment
 * summary: subtotal before the discount, the discount, the subtotal after
 * it, each tax and the total. Read from the contract's commercial snapshot
 * (or client_payment_summary's "pricing", the same fields); never
 * recalculated. Null when the contract has no discount.
 */
export type DiscountBreakdown = {
  subtotalCents: number;
  discount: { description: string; amountCents: number };
  discountedSubtotalCents: number;
  taxes: { label: string; ratePpm: number; amountCents: number }[];
  totalCents: number;
};

const isCents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function discountBreakdown(frozen: unknown): DiscountBreakdown | null {
  if (!frozen || typeof frozen !== "object") return null;
  const f = frozen as Record<string, unknown>;
  const d = f.discount as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || typeof d.label !== "string" || !isCents(d.amount_cents)) return null;
  if (!isCents(f.subtotal_cents) || !isCents(f.discounted_subtotal_cents) || !isCents(f.total_cents) || !Array.isArray(f.tax_breakdown)) return null;
  const bp = typeof d.percent_basis_points === "number" ? d.percent_basis_points : undefined;
  return {
    subtotalCents: f.subtotal_cents,
    discount: { description: discountDescription({ type: String(d.type), label: d.label, percent_basis_points: bp }), amountCents: d.amount_cents },
    discountedSubtotalCents: f.discounted_subtotal_cents,
    taxes: (f.tax_breakdown as Record<string, unknown>[])
      .filter((t) => isCents(t.amount_cents) && (t.amount_cents as number) > 0)
      .map((t) => ({ label: String(t.label), ratePpm: Number(t.rate_ppm), amountCents: t.amount_cents as number })),
    totalCents: f.total_cents,
  };
}

/**
 * An absolute https:// address with a dotted host name and no credentials,
 * whitespace or angle brackets. Mirrors private.is_https_url, which is the
 * authority; this only gives an earlier, clearer message.
 */
export function isHttpsUrl(value: string): boolean {
  if (value.length > 2000 || /[\s<>"\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && value.toLowerCase().startsWith("https://");
}

/** The host shown next to an invoice link, so staff and clients see where it goes. */
export function linkHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

/** Today's date (YYYY-MM-DD) in a time zone, for the payment date default. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
