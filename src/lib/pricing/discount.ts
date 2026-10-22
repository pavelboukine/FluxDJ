import type { OfferDiscount, OfferSnapshot } from "./offer-snapshot";
import { priceSelection, type AnswerValue } from "./price-selection";

/**
 * Proposal discount policy (documented, single, and mirrored by the database
 * check private.verify_proposal_selection):
 *
 *   1. subtotal = sum of line totals (packages, add-ons, required gear, after
 *      this proposal's custom prices).
 *   2. discount = round_half_up(subtotal * basis_points / 10,000) for a
 *      percentage, or min(amount, subtotal) for a fixed amount.
 *   3. The discount is allocated to the lines in proportion to their totals
 *      (largest remainder; ties go to the earlier line), so every line keeps
 *      a non-negative amount and each tax category is taxed on its
 *      discounted amount.
 *   4. Taxes follow the existing per-line, per-tax half-up rule on each
 *      line's discounted amount.
 *   5. total = subtotal - discount + taxes.
 *
 * All amounts are non-negative integer cents; BigInt keeps products exact.
 */

const BP = BigInt(10_000);
const HALF_BP = BigInt(5_000);

export function discountCents(subtotalCents: number, discount: OfferDiscount | undefined): number {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) throw new RangeError("invalid subtotal");
  if (!discount) return 0;
  if (discount.type === "fixed") return Math.min(discount.amount_cents, subtotalCents);
  return Number((BigInt(subtotalCents) * BigInt(discount.percent_basis_points) + HALF_BP) / BP);
}

/** Splits `discount` over `amounts` proportionally; the result sums to `discount` and never exceeds an amount. */
export function allocateDiscount(amounts: readonly number[], discount: number): number[] {
  const total = amounts.reduce((a, v) => a + v, 0);
  if (discount < 0 || discount > total) throw new RangeError("discount exceeds the amounts");
  if (discount === 0 || total === 0) return amounts.map(() => 0);
  const d = BigInt(discount);
  const s = BigInt(total);
  const shares = amounts.map((a, index) => ({ index, base: (d * BigInt(a)) / s, remainder: (d * BigInt(a)) % s }));
  let left = discount - shares.reduce((acc, x) => acc + Number(x.base), 0);
  const order = [...shares].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const result = shares.map((x) => Number(x.base));
  for (const x of order) {
    if (left === 0) break;
    result[x.index] += 1;
    left -= 1;
  }
  return result;
}

/** "10%", "12.5%", "33.33%". */
export function discountRateLabel(basisPoints: number): string {
  return `${(basisPoints / 100).toLocaleString("en-CA", { maximumFractionDigits: 2 })}%`;
}

/** "Wedding Special (10%)", or just the label for a fixed amount. */
export function discountDescription(discount: Pick<OfferDiscount, "label"> & { type: string; percent_basis_points?: number }): string {
  return discount.type === "percent" && discount.percent_basis_points ? `${discount.label} (${discountRateLabel(discount.percent_basis_points)})` : discount.label;
}

/** A draft offer's discount, as staff entered it (proposals.draft_offer "discount"). */
export type DraftDiscount =
  | { type: "percent"; percent_basis_points: number; label: string | null }
  | { type: "fixed"; amount_cents: number; label: string | null };

export type DiscountKind = "none" | "percent" | "fixed";

/** "10" or "12.5" (at most two decimals, 0 to 100) -> basis points; null when not a valid percentage. */
export function parsePercentToBasisPoints(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/%$/, "").trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

/** Basis points -> "12.5" for the percentage field. */
export function basisPointsToInputValue(bp: number): string {
  return String(bp / 100);
}

/**
 * The Discount fields -> the draft's discount. No discount, an empty value or
 * zero mean none (null). Limits mirror private.is_valid_discount; a fixed
 * amount is checked against the offer's lowest possible subtotal
 * (maxFixedCents) when known, and always again by the database when the
 * offer is built.
 */
export function readDiscount(
  fields: { kind: string; value: string; label: string },
  parseMoney: (input: string) => number | null,
  /** The offer's lowest possible subtotal (minimumSelectionSubtotal), when known. */
  maxFixedCents?: number | null,
): { ok: true; discount: DraftDiscount | null } | { ok: false; error: string } {
  const label = fields.label.trim();
  if (label.length > 80) return { ok: false, error: "The discount description can be at most 80 characters." };
  if (fields.kind === "none" || fields.kind === "" || fields.value.trim() === "") return { ok: true, discount: null };
  if (fields.kind === "percent") {
    const bp = parsePercentToBasisPoints(fields.value);
    if (bp === null) return { ok: false, error: "Enter a discount percentage from 0 to 100, like 10 or 12.5." };
    return { ok: true, discount: bp === 0 ? null : { type: "percent", percent_basis_points: bp, label: label || null } };
  }
  if (fields.kind === "fixed") {
    const cents = parseMoney(fields.value);
    if (cents === null || cents > 100_000_000) return { ok: false, error: "Enter a discount amount like 200 or 200.00." };
    if (cents > 0 && maxFixedCents != null && cents > maxFixedCents) {
      return { ok: false, error: "The discount amount can't be more than the lowest possible subtotal of this proposal." };
    }
    return { ok: true, discount: cents === 0 ? null : { type: "fixed", amount_cents: cents, label: label || null } };
  }
  return { ok: false, error: "Choose a discount type." };
}

/** Most answer combinations minimumSelectionSubtotal tries; mirrored by private.offer_min_subtotal. */
export const MINIMUM_SUBTOTAL_COMBINATIONS = 4096;

/**
 * The lowest subtotal any complete selection of this offer can have: the
 * largest fixed discount it allows (mirrored by private.offer_min_subtotal).
 * Every package is tried with every combination of answers to the required
 * yes/no and single-choice questions that have gear rules (the only answers
 * a client must give that can add charges); optional add-ons are left at zero,
 * optional questions unanswered and multi-choice questions answered "none".
 * Custom prices are already in the offer. Above MINIMUM_SUBTOTAL_COMBINATIONS
 * combinations it falls back to the lowest package price, which never
 * exceeds the true minimum.
 */
export function minimumSelectionSubtotal(offer: OfferSnapshot): number {
  const lowestPackage = Math.min(...offer.packages.map((p) => p.base_price_cents));
  const withRules = new Set(offer.rules.map((r) => r.question_key));
  const varying = offer.questions
    .filter((q) => q.required && withRules.has(q.key) && (q.answer_type === "boolean" || q.answer_type === "single_choice"))
    .map((q) => ({ key: q.key, values: (q.answer_type === "boolean" ? [true, false] : q.options.map((o) => o.value)) as AnswerValue[] }));
  const combinations = varying.reduce((n, q) => n * q.values.length, 1);
  if (combinations > MINIMUM_SUBTOTAL_COMBINATIONS) return lowestPackage;

  // Any valid answer for the other required questions: they can't add charges.
  const fixed: Record<string, AnswerValue> = {};
  for (const q of offer.questions) {
    if (!q.required || varying.some((v) => v.key === q.key)) continue;
    fixed[q.key] = q.answer_type === "boolean" ? false : q.answer_type === "multi_choice" ? [] : q.answer_type === "single_choice" ? q.options[0].value : "-";
  }
  const plain = { ...offer, discount: undefined };
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < combinations; i++) {
    const answers = { ...fixed };
    let rest = i;
    for (const q of varying) {
      answers[q.key] = q.values[rest % q.values.length];
      rest = Math.floor(rest / q.values.length);
    }
    for (const p of offer.packages) {
      const priced = priceSelection(plain, { package_key: p.key, answers });
      if (priced.ok && priced.selection.subtotal_cents < lowest) lowest = priced.selection.subtotal_cents;
    }
  }
  return Number.isFinite(lowest) ? lowest : lowestPackage;
}
