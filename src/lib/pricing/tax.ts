import type { OfferSnapshot } from "./offer-snapshot";

/**
 * Tax policy (documented, single, and mirrored by the database check
 * private.verify_proposal_selection):
 *
 *   For every line and every tax code that applies to the line's tax
 *   category, tax = round_half_up(line_total_cents * rate_ppm / 1,000,000).
 *   Each tax code's amount is the sum of its rounded line amounts.
 *
 * All amounts are non-negative integers, so half-up is
 * floor((a * r + 500000) / 1000000). BigInt keeps the product exact.
 */
const PPM = BigInt(1_000_000);
const HALF = BigInt(500_000);

export function roundedLineTax(lineTotalCents: number, ratePpm: number): number {
  if (!Number.isSafeInteger(lineTotalCents) || lineTotalCents < 0) throw new RangeError("invalid line total");
  if (!Number.isInteger(ratePpm) || ratePpm < 0 || ratePpm > 1_000_000) throw new RangeError("invalid rate");
  return Number((BigInt(lineTotalCents) * BigInt(ratePpm) + HALF) / PPM);
}

export interface TaxLine {
  line_total_cents: number;
  tax_category: string;
}

export interface TaxBreakdownEntry {
  code: string;
  label: string;
  rate_ppm: number;
  taxable_cents: number;
  amount_cents: number;
}

/** One entry per configured rate, in configuration order, including zero entries. */
export function computeTaxBreakdown(lines: readonly TaxLine[], tax: OfferSnapshot["tax"]): TaxBreakdownEntry[] {
  return tax.rates.map((rate) => {
    let taxable = 0;
    let amount = 0;
    for (const line of lines) {
      const codes = tax.categories[line.tax_category];
      if (!codes) throw new Error(`tax category ${line.tax_category} is not configured`);
      if (!codes.includes(rate.code)) continue;
      taxable += line.line_total_cents;
      amount += roundedLineTax(line.line_total_cents, rate.rate_ppm);
    }
    return { code: rate.code, label: rate.label, rate_ppm: rate.rate_ppm, taxable_cents: taxable, amount_cents: amount };
  });
}
