import { z } from "zod";
import { KEY_PATTERN } from "./offer-snapshot";
import { PRICING_VERSION, type AnswerValue, type GearRequirement, type PricedLine, type PricedSelection } from "./price-selection";
import type { TaxBreakdownEntry } from "./tax";

/**
 * A stored priced selection (proposal_selections.selection_snapshot), read
 * back from the database: what the client submitted, after
 * private.verify_proposal_selection checked every line, the discount, the
 * taxes and the totals against the frozen offer. Read-only displays use it
 * exactly as stored, never repriced. The checks below are the invariants the
 * database guaranteed when it stored the record (the line total and total
 * constraints, the subtotal and tax sums), so a response that breaks one is
 * not a stored selection. Unknown fields are dropped.
 *
 * pricing_version stays "flux-pricing-1": a new pricing version needs its own
 * schema. Records stored before proposal discounts have no discount fields.
 */

const key = z.string().regex(KEY_PATTERN);
const cents = z.int().nonnegative();
const answerValue: z.ZodType<AnswerValue> = z.union([z.boolean(), z.string(), z.array(z.string())]);

const lineSchema: z.ZodType<PricedLine> = z
  .object({
    source: z.enum(["package", "included", "optional", "required"]),
    item_key: key,
    name: z.string().min(1),
    description: z.string().nullable(),
    quantity: z.int().min(1),
    unit_price_cents: cents,
    line_total_cents: cents,
    required_quantity: z.int().nonnegative(),
    required_reasons: z.array(z.string()),
    tax_category: key,
    discount_cents: cents.optional(),
  })
  .refine((l) => l.line_total_cents === l.quantity * l.unit_price_cents, "line total is not quantity times unit price")
  .refine((l) => (l.discount_cents ?? 0) <= l.line_total_cents, "line discount exceeds the line total");

const requirementSchema: z.ZodType<GearRequirement> = z.object({
  gear_key: key,
  required_quantity: z.int().nonnegative(),
  included_quantity: z.int().nonnegative(),
  required_extra_quantity: z.int().nonnegative(),
  reasons: z.array(z.string()),
});

const taxEntrySchema: z.ZodType<TaxBreakdownEntry> = z.object({
  code: z.string().min(1),
  label: z.string(),
  rate_ppm: z.int().min(0).max(1_000_000),
  taxable_cents: cents,
  amount_cents: cents,
});

const sum = (values: number[]) => values.reduce((a, v) => a + v, 0);

export const pricedSelectionSchema: z.ZodType<PricedSelection> = z
  .object({
    pricing_version: z.literal(PRICING_VERSION),
    currency: z.string().regex(/^[A-Z]{3}$/),
    package_key: key,
    addon_quantities: z.record(z.string(), z.int().nonnegative()),
    logistics_answers: z.record(z.string(), answerValue),
    requirements: z.array(requirementSchema),
    lines: z.array(lineSchema).min(1),
    subtotal_cents: cents,
    discount: z
      .object({
        type: z.enum(["percent", "fixed"]),
        label: z.string(),
        percent_basis_points: z.int().min(1).max(10_000).optional(),
        fixed_amount_cents: cents.optional(),
      })
      .optional(),
    discount_cents: cents.optional(),
    tax_breakdown: z.array(taxEntrySchema),
    tax_cents: cents,
    total_cents: cents,
  })
  .superRefine((s, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (s.lines.filter((l) => l.source === "package").length !== 1 || s.lines.find((l) => l.source === "package")?.item_key !== s.package_key) {
      issue("exactly one package line, for the selected package", "lines");
    }
    if (s.subtotal_cents !== sum(s.lines.map((l) => l.line_total_cents))) issue("subtotal is not the sum of the lines", "subtotal_cents");
    const discount = s.discount_cents ?? 0;
    if ((s.discount === undefined) !== (s.discount_cents === undefined)) issue("discount and discount_cents come together", "discount");
    if (discount > s.subtotal_cents) issue("discount exceeds the subtotal", "discount_cents");
    if (s.tax_cents !== sum(s.tax_breakdown.map((t) => t.amount_cents))) issue("tax is not the sum of the breakdown", "tax_cents");
    if (s.total_cents !== s.subtotal_cents - discount + s.tax_cents) issue("total is not subtotal - discount + tax", "total_cents");
  });

/** A stored selection record: the priced selection and the hash of the offer it was priced against. */
export const selectionRecordSchema = z.intersection(pricedSelectionSchema, z.object({ offer_sha256: z.string().regex(/^[0-9a-f]{64}$/) }));
