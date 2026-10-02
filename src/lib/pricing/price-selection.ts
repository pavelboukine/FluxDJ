import { z } from "zod";
import type { OfferQuestion, OfferSnapshot, RuleCondition } from "./offer-snapshot";
import { computeTaxBreakdown, type TaxBreakdownEntry } from "./tax";

/**
 * Deterministic pricing of a client selection against a frozen offer
 * (spec section 5). Pure: no I/O, no clock, no randomness. The same offer and
 * input always produce the same output, which lets the browser show a preview
 * while the server remains authoritative.
 *
 * Client input carries only choices: a package key, addon quantities and
 * logistics answers. Any other field (for example a price or total) is
 * rejected; monetary values come solely from the frozen offer.
 */

export const PRICING_VERSION = "flux-pricing-1";
export const SHORT_TEXT_MAX = 2000;

export const selectionInputSchema = z.strictObject({
  package_key: z.string(),
  addons: z.record(z.string(), z.unknown()).optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
});
export type SelectionInput = z.infer<typeof selectionInputSchema>;

export type PricingErrorCode =
  | "input_invalid"
  | "package_not_offered"
  | "addon_not_offered"
  | "addon_quantity_invalid"
  | "answer_unknown_question"
  | "answer_missing"
  | "answer_invalid";

export interface PricingError {
  code: PricingErrorCode;
  path: string;
  message: string;
}

export type AnswerValue = boolean | string | string[];

export type LineSource = "package" | "included" | "optional" | "required";

export interface PricedLine {
  source: LineSource;
  item_key: string;
  name: string;
  description: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  /** Minimum chargeable quantity imposed by rules, after package inclusions. */
  required_quantity: number;
  required_reasons: string[];
  tax_category: string;
}

export interface GearRequirement {
  gear_key: string;
  required_quantity: number;
  included_quantity: number;
  required_extra_quantity: number;
  reasons: string[];
}

export interface PricedSelection {
  pricing_version: typeof PRICING_VERSION;
  currency: string;
  package_key: string;
  /** Normalized: offered addons with quantity > 0, in offer order. */
  addon_quantities: Record<string, number>;
  /** Normalized: answered questions only, in offer order. */
  logistics_answers: Record<string, AnswerValue>;
  requirements: GearRequirement[];
  lines: PricedLine[];
  subtotal_cents: number;
  tax_breakdown: TaxBreakdownEntry[];
  tax_cents: number;
  total_cents: number;
}

export type PricingResult = { ok: true; selection: PricedSelection } | { ok: false; errors: PricingError[] };

export function priceSelection(offer: OfferSnapshot, rawInput: unknown): PricingResult {
  const parsed = selectionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: "input_invalid",
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  const input = parsed.data;
  const errors: PricingError[] = [];

  // 1. The selected package must be one of the offered packages.
  const pkg = offer.packages.find((p) => p.key === input.package_key);
  if (!pkg) {
    errors.push({ code: "package_not_offered", path: "package_key", message: "Package is not part of this offer." });
  }

  // 2. Addons must be offered, with integer quantities within bounds.
  const offeredAddons = new Map(offer.addons.map((a) => [a.gear_key, a]));
  const addonQuantities = new Map<string, number>();
  for (const [gearKey, quantity] of Object.entries(input.addons ?? {})) {
    const addon = offeredAddons.get(gearKey);
    if (!addon) {
      errors.push({ code: "addon_not_offered", path: `addons.${gearKey}`, message: "Addon is not part of this offer." });
      continue;
    }
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0 || quantity > addon.max_quantity) {
      errors.push({
        code: "addon_quantity_invalid",
        path: `addons.${gearKey}`,
        message: `Quantity must be a whole number from 0 to ${addon.max_quantity}.`,
      });
      continue;
    }
    addonQuantities.set(gearKey, quantity);
  }

  // 3. Answers must match offered questions; required answers must be present.
  const questions = new Map(offer.questions.map((q) => [q.key, q]));
  const rawAnswers = input.answers ?? {};
  for (const answerKey of Object.keys(rawAnswers)) {
    if (!questions.has(answerKey)) {
      errors.push({ code: "answer_unknown_question", path: `answers.${answerKey}`, message: "Question is not part of this offer." });
    }
  }
  const answers = new Map<string, AnswerValue>();
  for (const question of offer.questions) {
    const raw = Object.hasOwn(rawAnswers, question.key) ? rawAnswers[question.key] : undefined;
    const result = normalizeAnswer(question, raw);
    if (result.kind === "invalid") {
      errors.push({ code: "answer_invalid", path: `answers.${question.key}`, message: result.message });
    } else if (result.kind === "missing") {
      if (question.required) {
        // Never interpret a missing required answer as false.
        errors.push({ code: "answer_missing", path: `answers.${question.key}`, message: "This question needs an answer." });
      }
    } else {
      answers.set(question.key, result.value);
    }
  }

  if (errors.length > 0 || !pkg) return { ok: false, errors };

  // 3b/4. Evaluate frozen rules and aggregate required quantities per gear item.
  // Quantities add up: two separate spaces needing a speaker each require two.
  const required = new Map<string, { quantity: number; reasons: string[] }>();
  for (const rule of offer.rules) {
    const answer = answers.get(rule.question_key);
    if (answer === undefined || !conditionMatches(rule.condition, answer)) continue;
    const entry = required.get(rule.gear_key) ?? { quantity: 0, reasons: [] };
    entry.quantity += rule.required_quantity;
    entry.reasons.push(rule.reason);
    required.set(rule.gear_key, entry);
  }

  // 5. Account for package inclusions.
  const included = new Map(pkg.included.map((i) => [i.gear_key, i.quantity]));
  const requirements: GearRequirement[] = [...required.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([gearKey, r]) => {
      const includedQuantity = included.get(gearKey) ?? 0;
      return {
        gear_key: gearKey,
        required_quantity: r.quantity,
        included_quantity: includedQuantity,
        required_extra_quantity: Math.max(0, r.quantity - includedQuantity),
        reasons: r.reasons,
      };
    });
  const requirementByGear = new Map(requirements.map((r) => [r.gear_key, r]));

  // 6/7. Lines: package base price, included gear (never charged), then
  // chargeable extras. For gear that is both required and optional:
  // chargeable = max(optional, requiredExtra), so it is charged once.
  const lines: PricedLine[] = [
    {
      source: "package",
      item_key: pkg.key,
      name: pkg.name,
      description: pkg.description,
      quantity: 1,
      unit_price_cents: pkg.base_price_cents,
      line_total_cents: pkg.base_price_cents,
      required_quantity: 0,
      required_reasons: [],
      tax_category: pkg.tax_category,
    },
  ];
  for (const inc of pkg.included) {
    const gear = offer.gear[inc.gear_key];
    lines.push({
      source: "included",
      item_key: gear.key,
      name: gear.name,
      description: gear.description,
      quantity: inc.quantity,
      unit_price_cents: 0,
      line_total_cents: 0,
      required_quantity: 0,
      required_reasons: [],
      tax_category: gear.tax_category,
    });
  }

  const extraKeys = [
    ...offer.addons.map((a) => a.gear_key),
    ...requirements.map((r) => r.gear_key).filter((k) => !offeredAddons.has(k)),
  ];
  for (const gearKey of extraKeys) {
    const gear = offer.gear[gearKey];
    const optional = addonQuantities.get(gearKey) ?? 0;
    const requirement = requirementByGear.get(gearKey);
    const requiredExtra = requirement?.required_extra_quantity ?? 0;
    const quantity = Math.max(optional, requiredExtra);
    if (quantity === 0) continue;
    lines.push({
      source: requiredExtra > 0 ? "required" : "optional",
      item_key: gear.key,
      name: gear.name,
      description: gear.description,
      quantity,
      unit_price_cents: gear.unit_price_cents,
      line_total_cents: safeMultiply(quantity, gear.unit_price_cents),
      required_quantity: requiredExtra,
      required_reasons: requiredExtra > 0 ? [...(requirement?.reasons ?? [])] : [],
      tax_category: gear.tax_category,
    });
  }

  // 8. Taxes from the frozen configuration with the documented rounding policy.
  const subtotal = safeSum(lines.map((l) => l.line_total_cents));
  const taxBreakdown = computeTaxBreakdown(lines, offer.tax);
  const tax = safeSum(taxBreakdown.map((t) => t.amount_cents));

  return {
    ok: true,
    selection: {
      pricing_version: PRICING_VERSION,
      currency: offer.currency,
      package_key: pkg.key,
      addon_quantities: Object.fromEntries(
        offer.addons.flatMap((a) => {
          const q = addonQuantities.get(a.gear_key) ?? 0;
          return q > 0 ? [[a.gear_key, q]] : [];
        }),
      ),
      logistics_answers: Object.fromEntries(
        offer.questions.flatMap((q) => (answers.has(q.key) ? [[q.key, answers.get(q.key)!]] : [])),
      ),
      requirements,
      lines,
      subtotal_cents: subtotal,
      tax_breakdown: taxBreakdown,
      tax_cents: tax,
      total_cents: safeSum([subtotal, tax]),
    },
  };
}

/** The record stored by record_proposal_selection. */
export function toSelectionRecord(selection: PricedSelection, offerSha256: string) {
  return { ...selection, offer_sha256: offerSha256 };
}
export type SelectionRecord = ReturnType<typeof toSelectionRecord>;

type NormalizedAnswer = { kind: "value"; value: AnswerValue } | { kind: "missing" } | { kind: "invalid"; message: string };

function normalizeAnswer(question: OfferQuestion, raw: unknown): NormalizedAnswer {
  if (raw === undefined || raw === null) return { kind: "missing" };
  const options = question.options.map((o) => o.value);
  switch (question.answer_type) {
    case "boolean":
      return typeof raw === "boolean" ? { kind: "value", value: raw } : { kind: "invalid", message: "Answer must be yes or no." };
    case "single_choice":
      return typeof raw === "string" && options.includes(raw)
        ? { kind: "value", value: raw }
        : { kind: "invalid", message: "Choose one of the listed options." };
    case "multi_choice": {
      if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && options.includes(v))) {
        return { kind: "invalid", message: "Choose from the listed options." };
      }
      if (new Set(raw).size !== raw.length) return { kind: "invalid", message: "Options may be chosen once." };
      // An empty list is an explicit "none of these" answer.
      return { kind: "value", value: options.filter((o) => raw.includes(o)) };
    }
    case "short_text": {
      if (typeof raw !== "string") return { kind: "invalid", message: "Answer must be text." };
      const text = raw.trim();
      if (text.length > SHORT_TEXT_MAX) return { kind: "invalid", message: `Answer is longer than ${SHORT_TEXT_MAX} characters.` };
      return text.length === 0 ? { kind: "missing" } : { kind: "value", value: text };
    }
  }
}

function conditionMatches(condition: RuleCondition, answer: AnswerValue): boolean {
  switch (condition.op) {
    case "equals":
      return answer === condition.value;
    case "in":
      return typeof answer === "string" && condition.values.includes(answer);
    case "contains":
      return Array.isArray(answer) && answer.includes(condition.value);
  }
}

function safeMultiply(a: number, b: number): number {
  const r = a * b;
  if (!Number.isSafeInteger(r)) throw new RangeError("amount exceeds safe integer range");
  return r;
}

function safeSum(values: number[]): number {
  const r = values.reduce((acc, v) => acc + v, 0);
  if (!Number.isSafeInteger(r)) throw new RangeError("amount exceeds safe integer range");
  return r;
}
