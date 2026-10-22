import { z } from "zod";
import { centsSchema, checkDbResponse, currencySchema, dateSchema, idSchema, timestampSchema } from "@/lib/db-response";
import { discountDescription } from "@/lib/pricing/discount";

/**
 * Manual payment tracking. Payments are received elsewhere (Wave, e-transfer,
 * cash...) and recorded by staff; Flux DJ never processes or verifies them.
 * Totals are computed only in the database (private.event_payment_summary)
 * from the event's authoritative contract; this module only describes them.
 */

const termsStatus = z.enum(["signed", "sent"]);

/** private.event_payment_summary, as staff receive it. */
export const paymentSummarySchema = z.object({
  currency: currencySchema,
  terms: z
    .object({
      status: termsStatus,
      contract_id: idSchema,
      total_cents: centsSchema,
      deposit_percent: z.int().min(0).max(100),
      deposit_cents: centsSchema,
      balance_cents: centsSchema,
      balance_due_date: dateSchema.nullable(),
    })
    .refine((t) => t.deposit_cents + t.balance_cents === t.total_cents, "deposit and balance don't add up to the total")
    .nullable(),
  received_cents: centsSchema,
  valid_payments: z.int().nonnegative(),
  other_currency_payments: z.int().nonnegative(),
  deposit_outstanding_cents: centsSchema.nullable(),
  remaining_balance_cents: centsSchema.nullable(),
  credit_cents: centsSchema.nullable(),
  invoice_url: z.string().nullable(),
  booking: z.object({
    // Shown and compared, never branched on exhaustively: a new status (added by a migration first) stays readable.
    lifecycle_status: z.string().min(1),
    booking_confirmed_at: timestampSchema.nullable(),
    /** The signed contract's frozen policy; null before signing or for legacy contracts. */
    policy: z.enum(["on_deposit", "on_signature"]).nullable(),
    /** Signed before booking policies existed: staff check it explicitly. */
    legacy_signed: z.boolean(),
    /** Booked under the deposit policy, but valid payments no longer cover the deposit. */
    deposit_no_longer_met: z.boolean(),
  }),
});
export type PaymentSummary = z.infer<typeof paymentSummarySchema>;

/**
 * A discounted contract's frozen price breakdown (its commercial snapshot,
 * or client_payment_summary's "pricing", the same fields). Built by
 * generate_contract_draft from the verified selection, so the discounted
 * subtotal and the total follow from the other figures.
 */
const frozenPricingSchema = z
  .object({
    subtotal_cents: centsSchema,
    discount: z.object({
      type: z.enum(["percent", "fixed"]),
      label: z.string(),
      percent_basis_points: z.int().min(1).max(10_000).optional(),
      amount_cents: centsSchema,
    }),
    discounted_subtotal_cents: centsSchema,
    tax_breakdown: z.array(z.object({ label: z.string(), rate_ppm: z.int().min(0).max(1_000_000), amount_cents: centsSchema })),
    total_cents: centsSchema,
  })
  .refine((f) => f.discounted_subtotal_cents === f.subtotal_cents - f.discount.amount_cents, "discounted subtotal doesn't follow from the discount")
  .refine((f) => f.total_cents === f.discounted_subtotal_cents + f.tax_breakdown.reduce((a, t) => a + t.amount_cents, 0), "total doesn't follow from the taxes");

/** client_payment_summary: only what the client may see. */
export const clientPaymentSummarySchema = z.object({
  currency: currencySchema,
  terms_status: termsStatus.nullable(),
  total_cents: centsSchema.nullable(),
  deposit_percent: z.int().min(0).max(100).nullable(),
  deposit_cents: centsSchema.nullable(),
  balance_due_date: dateSchema.nullable(),
  received_cents: centsSchema,
  deposit_outstanding_cents: centsSchema.nullable(),
  remaining_balance_cents: centsSchema.nullable(),
  credit_cents: centsSchema.nullable(),
  invoice_url: z.string().nullable(),
  booking_status: z.enum(["booked", "awaiting_deposit"]).nullable(),
  /** Only for a contract generated from a discounted proposal: its frozen price breakdown (see discountBreakdown). */
  pricing: frozenPricingSchema.optional(),
});
export type ClientPaymentSummary = z.infer<typeof clientPaymentSummarySchema>;

/**
 * A payment summary (staff or client), or null when there is none (the
 * function returned null, or failed). One that fails validation is logged
 * and treated as unavailable: no payment figures rather than wrong ones.
 */
export function readPaymentSummary(data: unknown, operation: "event_payment_summary"): PaymentSummary | null;
export function readPaymentSummary(data: unknown, operation: "client_payment_summary"): ClientPaymentSummary | null;
export function readPaymentSummary(data: unknown, operation: "event_payment_summary" | "client_payment_summary") {
  if (data === null || data === undefined) return null;
  const checked = checkDbResponse(operation === "event_payment_summary" ? paymentSummarySchema : clientPaymentSummarySchema, data, operation);
  return checked.ok ? checked.data : null;
}

/**
 * A discounted contract's frozen price breakdown, as shown with its payment
 * summary: subtotal before the discount, the discount, the subtotal after
 * it, each tax and the total. Read from the contract's commercial snapshot
 * (or client_payment_summary's "pricing"); never recalculated. Null when the
 * contract has no discount, and when its breakdown fails validation (logged):
 * the agreed total is still shown from the contract's terms.
 */
export type DiscountBreakdown = {
  subtotalCents: number;
  discount: { description: string; amountCents: number };
  discountedSubtotalCents: number;
  taxes: { label: string; ratePpm: number; amountCents: number }[];
  totalCents: number;
};

export function discountBreakdown(frozen: unknown): DiscountBreakdown | null {
  if (!frozen || typeof frozen !== "object" || !("discount" in frozen)) return null;
  const checked = checkDbResponse(frozenPricingSchema, frozen, "contract discount breakdown");
  if (!checked.ok) return null;
  const f = checked.data;
  return {
    subtotalCents: f.subtotal_cents,
    discount: { description: discountDescription(f.discount), amountCents: f.discount.amount_cents },
    discountedSubtotalCents: f.discounted_subtotal_cents,
    // A tax that came to nothing (a zero rate, or nothing taxable) isn't listed.
    taxes: f.tax_breakdown.filter((t) => t.amount_cents > 0).map((t) => ({ label: t.label, ratePpm: t.rate_ppm, amountCents: t.amount_cents })),
    totalCents: f.total_cents,
  };
}

/** Today's date (YYYY-MM-DD) in a time zone, for the payment date default. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
