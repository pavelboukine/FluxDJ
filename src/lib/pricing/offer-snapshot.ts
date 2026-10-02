import { z } from "zod";

/**
 * Frozen offer snapshot, schema version 1.
 *
 * Produced only by the database function `create_proposal_offer`, which copies
 * catalog and template data at creation time. Pricing reads this snapshot and
 * never the live catalog, so later catalog edits cannot change offered terms.
 * Parsing re-checks every cross-reference so a malformed snapshot can never be
 * priced.
 */

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const key = z.string().regex(KEY_PATTERN);
const cents = z.number().int().min(0).max(100_000_000);

const optionSchema = z.strictObject({ value: key, label: z.string().min(1) });

const questionSchema = z.strictObject({
  key,
  prompt: z.string().min(1),
  answer_type: z.enum(["boolean", "single_choice", "multi_choice", "short_text"]),
  options: z.array(optionSchema),
  required: z.boolean(),
});

const conditionSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("equals"), value: z.union([z.boolean(), key]) }),
  z.strictObject({ op: z.literal("in"), values: z.array(key).min(1) }),
  z.strictObject({ op: z.literal("contains"), value: key }),
]);

const ruleSchema = z.strictObject({
  question_key: key,
  condition: conditionSchema,
  gear_key: key,
  required_quantity: z.number().int().min(1).max(100),
  reason: z.string().min(1),
});

const gearSchema = z.strictObject({
  key,
  name: z.string().min(1),
  description: z.string().nullable(),
  unit_label: z.string().min(1),
  unit_price_cents: cents,
  tax_category: key,
  media: z.array(
    z.strictObject({
      storage_path: z.string().min(1),
      kind: z.enum(["image", "video"]),
      content_type: z.string().min(1),
      alt_text: z.string().min(1),
    }),
  ),
});

const packageSchema = z.strictObject({
  key,
  name: z.string().min(1),
  description: z.string().nullable(),
  base_price_cents: cents,
  tax_category: key,
  is_popular: z.boolean(),
  included: z.array(z.strictObject({ gear_key: key, quantity: z.number().int().min(1).max(100) })),
});

const taxRateSchema = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]{1,16}$/),
  label: z.string().min(1),
  rate_ppm: z.number().int().min(0).max(1_000_000),
});

export const offerSnapshotSchema = z
  .strictObject({
    schema_version: z.literal(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    intro: z.string().nullable(),
    expiry_days: z.number().int().min(1).max(365),
    branding: z.strictObject({
      display_name: z.string().min(1),
      logo_storage_path: z.string().nullable(),
      brand_colors: z.record(z.string(), z.string()),
    }),
    tax: z.strictObject({
      rounding: z.literal("per_line_per_tax_half_up"),
      rates: z.array(taxRateSchema),
      categories: z.record(key, z.array(z.string())),
    }),
    packages: z.array(packageSchema).length(3),
    gear: z.record(key, gearSchema),
    addons: z.array(
      z
        .strictObject({
          gear_key: key,
          recommended_quantity: z.number().int().min(0).max(100),
          max_quantity: z.number().int().min(1).max(100),
        })
        .refine((a) => a.recommended_quantity <= a.max_quantity, "recommended_quantity exceeds max_quantity"),
    ),
    questions: z.array(questionSchema),
    rules: z.array(ruleSchema),
  })
  .superRefine((offer, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: "custom", message, path });
    const hasGear = (k: string) => Object.hasOwn(offer.gear, k);
    const hasCategory = (c: string) => Object.hasOwn(offer.tax.categories, c);

    if (offer.packages.filter((p) => p.is_popular).length !== 1) {
      issue("exactly one package must be marked most popular", ["packages"]);
    }
    const unique = (values: string[], path: string) => {
      if (new Set(values).size !== values.length) issue(`duplicate keys in ${path}`, [path]);
    };
    unique(offer.packages.map((p) => p.key), "packages");
    unique(offer.addons.map((a) => a.gear_key), "addons");
    unique(offer.questions.map((q) => q.key), "questions");
    unique(offer.tax.rates.map((r) => r.code), "tax.rates");

    for (const [k, g] of Object.entries(offer.gear)) {
      if (g.key !== k) issue(`gear entry ${k} has mismatched key`, ["gear", k]);
      if (!hasCategory(g.tax_category)) issue(`gear ${k} tax category is not configured`, ["gear", k]);
    }
    offer.packages.forEach((p, i) => {
      if (!hasCategory(p.tax_category)) issue(`package ${p.key} tax category is not configured`, ["packages", i]);
      unique(p.included.map((inc) => inc.gear_key), `packages.${i}.included`);
      for (const inc of p.included) if (!hasGear(inc.gear_key)) issue(`included gear ${inc.gear_key} missing`, ["packages", i]);
    });
    const rateCodes = new Set(offer.tax.rates.map((r) => r.code));
    for (const [cat, codes] of Object.entries(offer.tax.categories)) {
      for (const code of codes) if (!rateCodes.has(code)) issue(`tax category ${cat} uses unknown code ${code}`, ["tax"]);
    }
    offer.addons.forEach((a, i) => {
      if (!hasGear(a.gear_key)) issue(`addon gear ${a.gear_key} missing`, ["addons", i]);
    });

    const questions = new Map(offer.questions.map((q) => [q.key, q]));
    offer.questions.forEach((q, i) => {
      const choice = q.answer_type === "single_choice" || q.answer_type === "multi_choice";
      if (choice !== q.options.length > 0) issue(`question ${q.key} options do not match its type`, ["questions", i]);
    });
    offer.rules.forEach((r, i) => {
      const q = questions.get(r.question_key);
      if (!q) {
        issue(`rule references question ${r.question_key} outside the offer`, ["rules", i]);
        return;
      }
      if (!hasGear(r.gear_key)) issue(`rule gear ${r.gear_key} missing`, ["rules", i]);
      if (!conditionFitsQuestion(r.condition, q)) issue(`rule condition does not fit question ${q.key}`, ["rules", i]);
    });
  });

export type OfferSnapshot = z.infer<typeof offerSnapshotSchema>;
export type OfferQuestion = z.infer<typeof questionSchema>;
export type RuleCondition = z.infer<typeof conditionSchema>;

/** Mirrors private.rule_condition_fits_question in the database. */
export function conditionFitsQuestion(condition: RuleCondition, question: OfferQuestion): boolean {
  const options = new Set(question.options.map((o) => o.value));
  switch (question.answer_type) {
    case "boolean":
      return condition.op === "equals" && typeof condition.value === "boolean";
    case "single_choice":
      if (condition.op === "equals") return typeof condition.value === "string" && options.has(condition.value);
      if (condition.op === "in") return condition.values.every((v) => options.has(v));
      return false;
    case "multi_choice":
      return condition.op === "contains" && options.has(condition.value);
    default:
      return false;
  }
}

/** Parses an untrusted snapshot (e.g. loaded from the database). Throws on any problem. */
export function parseOfferSnapshot(value: unknown): OfferSnapshot {
  return offerSnapshotSchema.parse(value);
}
