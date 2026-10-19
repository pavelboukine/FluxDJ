import { describe, expect, it } from "vitest";
import {
  allocateDiscount,
  discountCents,
  minimumSelectionSubtotal,
  discountDescription,
  parseOfferSnapshot,
  parsePercentToBasisPoints,
  priceSelection,
  readDiscount,
  type OfferSnapshot,
  type PricedSelection,
  type PricingResult,
} from "@/lib/pricing";
import { parseMoneyToCents } from "@/lib/money";
import { discountBreakdown } from "@/lib/payments";
import { baseAnswers, demoOffer } from "./fixtures/offer";

function priced(result: PricingResult): PricedSelection {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.errors)}`);
  return result.selection;
}
const withDiscount = (discount: OfferSnapshot["discount"], change?: (o: OfferSnapshot) => void): OfferSnapshot => {
  const offer = demoOffer();
  change?.(offer);
  return { ...offer, discount };
};
const sameRoom = { ...baseAnswers };
const bothSeparate = { ...baseAnswers, ceremony_location: "separate_space", cocktail_location: "separate_space" };

describe("discount amount", () => {
  it("rounds a percentage half up to the cent, and caps a fixed amount at the subtotal", () => {
    expect(discountCents(180_000, { type: "percent", percent_basis_points: 1000, label: "x" })).toBe(18_000);
    // 333.33 * 12.5% = 41.66625 -> 41.67
    expect(discountCents(33_333, { type: "percent", percent_basis_points: 1250, label: "x" })).toBe(4_167);
    // 0.05 * 10% = 0.005 -> rounds half up to 0.01
    expect(discountCents(5, { type: "percent", percent_basis_points: 1000, label: "x" })).toBe(1);
    expect(discountCents(4, { type: "percent", percent_basis_points: 1000, label: "x" })).toBe(0);
    expect(discountCents(180_000, { type: "percent", percent_basis_points: 10_000, label: "x" })).toBe(180_000);
    expect(discountCents(180_000, { type: "fixed", amount_cents: 20_000, label: "x" })).toBe(20_000);
    expect(discountCents(10_000, { type: "fixed", amount_cents: 20_000, label: "x" })).toBe(10_000);
    expect(discountCents(180_000, undefined)).toBe(0);
  });

  it("stays exact for large amounts", () => {
    expect(discountCents(999_999_999_999, { type: "percent", percent_basis_points: 3333, label: "x" })).toBe(333_300_000_000); // 333,299,999,999.67 rounds up
  });
});

describe("allocation to lines", () => {
  it("sums to the discount, follows the line totals, and gives ties to the earlier line", () => {
    expect(allocateDiscount([150_000, 30_000], 18_000)).toEqual([15_000, 3_000]);
    expect(allocateDiscount([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(allocateDiscount([100, 0, 200], 100)).toEqual([33, 0, 67]);
    expect(allocateDiscount([0, 0], 0)).toEqual([0, 0]);
  });

  it("never gives a line more than its total", () => {
    const amounts = [1, 2, 3, 999_997];
    for (const d of [0, 1, 7, 500_000, 1_000_003]) {
      const shares = allocateDiscount(amounts, d);
      expect(shares.reduce((a, v) => a + v, 0)).toBe(d);
      shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(amounts[i]));
    }
    expect(() => allocateDiscount([10], 11)).toThrow(RangeError);
  });
});

describe("pricing with a proposal discount", () => {
  it("leaves an offer without a discount exactly as before", () => {
    const s = priced(priceSelection(demoOffer(), { package_key: "signature", answers: bothSeparate }));
    expect(s).not.toHaveProperty("discount");
    expect(s).not.toHaveProperty("discount_cents");
    expect(s.lines.every((l) => !("discount_cents" in l))).toBe(true);
    expect(s.total_cents).toBe(270_191);
  });

  it("takes a percentage off the subtotal, then taxes the discounted amount", () => {
    const s = priced(priceSelection(withDiscount({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" }), { package_key: "signature", answers: bothSeparate }));
    expect(s.subtotal_cents).toBe(235_000);
    expect(s.discount).toEqual({ type: "percent", label: "Wedding Special", percent_basis_points: 1000 });
    expect(s.discount_cents).toBe(23_500);
    // Lines 220,000 and 15,000 get 22,000 and 1,500: taxed on 198,000 and 13,500.
    expect(s.lines.filter((l) => l.line_total_cents > 0).map((l) => l.discount_cents)).toEqual([22_000, 1_500]);
    expect(s.tax_breakdown).toEqual([
      { code: "GST", label: "GST", rate_ppm: 50_000, taxable_cents: 211_500, amount_cents: 10_575 },
      // 198000 * 9.975% = 19750.5 -> 19751; 13500 * 9.975% = 1346.625 -> 1347
      { code: "QST", label: "QST", rate_ppm: 99_750, taxable_cents: 211_500, amount_cents: 21_098 },
    ]);
    expect(s.tax_cents).toBe(31_673);
    expect(s.total_cents).toBe(235_000 - 23_500 + 31_673);
  });

  it("takes a fixed amount off and recalculates when quantities or custom prices change", () => {
    const offer = withDiscount({ type: "fixed", amount_cents: 20_000, label: "Returning Client Discount" });
    const one = priced(priceSelection(offer, { package_key: "signature", answers: sameRoom }));
    const more = priced(priceSelection(offer, { package_key: "signature", answers: bothSeparate, addons: { additional_location_speaker: 3 } }));
    expect(one.discount_cents).toBe(20_000);
    expect(more.discount_cents).toBe(20_000);
    expect(more.subtotal_cents).toBeGreaterThan(one.subtotal_cents);
    expect(more.lines.reduce((a, l) => a + (l.discount_cents ?? 0), 0)).toBe(20_000);

    const pct = (price: number) =>
      priced(priceSelection(withDiscount({ type: "percent", percent_basis_points: 1000, label: "x" }, (o) => (o.packages[1].base_price_cents = price)), { package_key: "signature", answers: sameRoom }));
    expect(pct(200_000).discount_cents).toBe(20_000);
    expect(pct(250_000).discount_cents).toBe(25_000);
  });

  it("allows 100% off: nothing to pay and no tax", () => {
    const s = priced(priceSelection(withDiscount({ type: "percent", percent_basis_points: 10_000, label: "Courtesy Discount" }), { package_key: "premium", answers: bothSeparate }));
    expect(s.discount_cents).toBe(s.subtotal_cents);
    expect(s.tax_cents).toBe(0);
    expect(s.total_cents).toBe(0);
  });

  it("taxes each category on its own discounted share (an exempt line pays no tax)", () => {
    const offer = withDiscount({ type: "percent", percent_basis_points: 5000, label: "Half off" }, (o) => {
      o.gear.additional_location_speaker = { ...o.gear.additional_location_speaker, tax_category: "exempt" };
    });
    const s = priced(priceSelection(offer, { package_key: "signature", answers: bothSeparate }));
    expect(s.tax_breakdown[0]).toMatchObject({ code: "GST", taxable_cents: 110_000, amount_cents: 5_500 });
  });

  it("is deterministic", () => {
    const offer = withDiscount({ type: "percent", percent_basis_points: 1234, label: "x" });
    const a = priceSelection(offer, { package_key: "premium", answers: bothSeparate, addons: { additional_location_speaker: 2 } });
    const b = priceSelection(structuredClone(offer), { addons: { additional_location_speaker: 2 }, answers: bothSeparate, package_key: "premium" });
    expect(a).toEqual(b);
  });
});

describe("frozen offer validation", () => {
  it("accepts a percentage or a fixed amount up to the lowest package price", () => {
    expect(() => parseOfferSnapshot(withDiscount({ type: "percent", percent_basis_points: 10_000, label: "x" }))).not.toThrow();
    expect(() => parseOfferSnapshot(withDiscount({ type: "fixed", amount_cents: 150_000, label: "x" }))).not.toThrow();
    // The exact limit (the lowest possible subtotal) is enforced when the database builds the offer.
    expect(() => parseOfferSnapshot(withDiscount({ type: "fixed", amount_cents: 165_000, label: "x" }))).not.toThrow();
    expect(() => parseOfferSnapshot(withDiscount({ type: "percent", percent_basis_points: 10_001, label: "x" }))).toThrow();
    expect(() => parseOfferSnapshot(withDiscount({ type: "percent", percent_basis_points: 0, label: "x" }))).toThrow();
    expect(() => parseOfferSnapshot({ ...demoOffer(), discount: { type: "fixed", amount_cents: -1, label: "x" } })).toThrow();
    expect(() => parseOfferSnapshot({ ...demoOffer(), discount: { type: "percent", percent_basis_points: 1000, label: "" } })).toThrow();
  });
});

describe("staff discount fields", () => {
  const read = (kind: string, value: string, label = "", lowest?: number) => readDiscount({ kind, value, label }, parseMoneyToCents, lowest);

  it("reads a percentage or an amount; none, empty or zero mean no discount", () => {
    expect(read("percent", "10", " Wedding Special ")).toEqual({ ok: true, discount: { type: "percent", percent_basis_points: 1000, label: "Wedding Special" } });
    expect(read("percent", "12.5%")).toEqual({ ok: true, discount: { type: "percent", percent_basis_points: 1250, label: null } });
    expect(read("fixed", "200")).toEqual({ ok: true, discount: { type: "fixed", amount_cents: 20_000, label: null } });
    expect(read("none", "10")).toEqual({ ok: true, discount: null });
    expect(read("percent", "")).toEqual({ ok: true, discount: null });
    expect(read("percent", "0")).toEqual({ ok: true, discount: null });
    expect(read("fixed", "0.00")).toEqual({ ok: true, discount: null });
  });

  it("refuses negative, too large or malformed values", () => {
    expect(read("percent", "-5").ok).toBe(false);
    expect(read("percent", "100.01").ok).toBe(false);
    expect(read("percent", "12.345").ok).toBe(false);
    expect(read("fixed", "-200").ok).toBe(false);
    expect(read("fixed", "abc").ok).toBe(false);
    expect(read("fixed", "1800.01", "", 180_000)).toEqual({ ok: false, error: "The discount amount can't be more than the lowest possible subtotal of this proposal." });
    expect(read("fixed", "1800", "", 180_000)).toEqual({ ok: true, discount: { type: "fixed", amount_cents: 180_000, label: null } });
    expect(read("percent", "10", "x".repeat(81)).ok).toBe(false);
    expect(parsePercentToBasisPoints("100")).toBe(10_000);
  });

  it("describes the discount for the client", () => {
    expect(discountDescription({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" })).toBe("Wedding Special (10%)");
    expect(discountDescription({ type: "percent", percent_basis_points: 1250, label: "Spring" })).toBe("Spring (12.5%)");
    expect(discountDescription({ type: "fixed", label: "Returning Client Discount" })).toBe("Returning Client Discount");
  });
});

describe("the largest fixed discount: the lowest possible subtotal", () => {
  const rule = (question_key: string, value: boolean | string, gear_key: string, required_quantity = 1) =>
    ({ question_key, condition: { op: "equals" as const, value }, gear_key, required_quantity, reason: "Needed." });
  const question = (key: string, answer_type: "boolean" | "single_choice", required: boolean, options: string[] = []) =>
    ({ key, prompt: `${key}?`, answer_type, required, options: options.map((value) => ({ value, label: value })) });
  /** Brute force over every package and every answer to every rule question (independent of the implementation). */
  const bruteForce = (offer: OfferSnapshot) => {
    let lowest = Infinity;
    const choices = (q: OfferSnapshot["questions"][number]) => (q.answer_type === "boolean" ? [true, false] : q.answer_type === "multi_choice" ? [[]] : q.answer_type === "short_text" ? ["x"] : q.options.map((o) => o.value));
    const walk = (i: number, answers: Record<string, unknown>) => {
      if (i === offer.questions.length) {
        for (const p of offer.packages) {
          const r = priceSelection({ ...offer, discount: undefined }, { package_key: p.key, answers });
          if (r.ok) lowest = Math.min(lowest, r.selection.subtotal_cents);
        }
        return;
      }
      const q = offer.questions[i];
      if (!q.required) walk(i + 1, answers);
      for (const v of choices(q)) walk(i + 1, { ...answers, [q.key]: v });
    };
    walk(0, {});
    return lowest;
  };

  it("is the cheapest package when every charge can be avoided; optional add-ons and optional questions never count", () => {
    const offer = demoOffer();
    expect(minimumSelectionSubtotal(offer)).toBe(150_000);
    expect(minimumSelectionSubtotal(offer)).toBe(bruteForce(offer));
  });

  it("includes gear every answer requires: $1,500 package + $300 mandatory gear allows $1,800 off", () => {
    const offer = demoOffer();
    offer.gear.power = { key: "power", name: "Power distribution", description: null, unit_label: "unit", unit_price_cents: 30_000, tax_category: "standard", media: [] };
    offer.questions.push(question("outdoor", "boolean", true));
    offer.rules.push(rule("outdoor", true, "power"), rule("outdoor", false, "power"));
    expect(minimumSelectionSubtotal(offer)).toBe(180_000);
    expect(bruteForce(offer)).toBe(180_000);
  });

  it("takes the cheapest required option, and gear the package includes isn't charged", () => {
    const offer = demoOffer();
    // Cocktails in the same room now need uplights (12,000); a separate space needs a speaker (15,000).
    offer.rules.push(rule("cocktail_location", "same_room", "uplights_4"));
    expect(minimumSelectionSubtotal(offer)).toBe(162_000);
    // Premium includes uplights: a cheaper Premium would win with nothing extra.
    offer.packages[2].base_price_cents = 155_000;
    expect(minimumSelectionSubtotal(offer)).toBe(155_000);
    expect(minimumSelectionSubtotal(offer)).toBe(bruteForce(offer));
  });

  it("follows custom prices frozen in the offer", () => {
    const offer = demoOffer();
    offer.questions.push(question("outdoor", "boolean", true));
    offer.rules.push(rule("outdoor", true, "uplights_4"), rule("outdoor", false, "uplights_4"));
    expect(minimumSelectionSubtotal(offer)).toBe(162_000);
    offer.gear.uplights_4 = { ...offer.gear.uplights_4, unit_price_cents: 10_000 };
    offer.packages[0].base_price_cents = 140_000;
    expect(minimumSelectionSubtotal(offer)).toBe(150_000);
  });

  it("ignores rules on optional questions", () => {
    const offer = demoOffer();
    offer.questions.push(question("dance_lessons", "boolean", false));
    offer.rules.push(rule("dance_lessons", true, "uplights_4"), rule("dance_lessons", false, "uplights_4"));
    expect(minimumSelectionSubtotal(offer)).toBe(150_000);
  });

  it("falls back to the lowest package price past 4,096 combinations (never above the true minimum)", () => {
    const offer = demoOffer();
    for (let i = 0; i < 12; i++) {
      offer.questions.push(question(`q${i}`, "boolean", true));
      offer.rules.push(rule(`q${i}`, true, "uplights_4"), rule(`q${i}`, false, "uplights_4"));
    }
    // 2 x 3 x 2 x 2^12 combinations: too many; the fallback is safe.
    expect(minimumSelectionSubtotal(offer)).toBe(150_000);
  });

  it("a fixed discount equal to it brings that selection to zero, with no tax", () => {
    const offer = demoOffer();
    offer.questions.push(question("outdoor", "boolean", true));
    offer.rules.push(rule("outdoor", true, "uplights_4"), rule("outdoor", false, "uplights_4"));
    const minimum = minimumSelectionSubtotal(offer);
    const s = priced(priceSelection({ ...offer, discount: { type: "fixed", amount_cents: minimum, label: "x" } }, { package_key: "essential", answers: { ...sameRoom, outdoor: false } }));
    expect(s.subtotal_cents).toBe(minimum);
    expect(s.discount_cents).toBe(minimum);
    expect(s.tax_cents).toBe(0);
    expect(s.total_cents).toBe(0);
    // A pricier choice keeps paying the difference, never less than zero.
    const more = priced(priceSelection({ ...offer, discount: { type: "fixed", amount_cents: minimum, label: "x" } }, { package_key: "premium", answers: { ...sameRoom, outdoor: false } }));
    expect(more.total_cents).toBeGreaterThan(0);
    expect(more.discount_cents).toBe(minimum);
  });
});

describe("payment summary breakdown (frozen, never recalculated)", () => {
  const frozen = {
    subtotal_cents: 220_000,
    discount: { type: "percent", label: "Wedding Special", percent_basis_points: 1000, amount_cents: 22_000 },
    discounted_subtotal_cents: 198_000,
    tax_breakdown: [
      { label: "GST", rate_ppm: 50_000, amount_cents: 9_900 },
      { label: "QST", rate_ppm: 99_750, amount_cents: 19_751 },
      { label: "HST", rate_ppm: 130_000, amount_cents: 0 },
    ],
    total_cents: 227_651,
  };

  it("reads a discounted contract's breakdown as frozen, leaving out taxes that don't apply", () => {
    expect(discountBreakdown(frozen)).toEqual({
      subtotalCents: 220_000,
      discount: { description: "Wedding Special (10%)", amountCents: 22_000 },
      discountedSubtotalCents: 198_000,
      taxes: [{ label: "GST", ratePpm: 50_000, amountCents: 9_900 }, { label: "QST", ratePpm: 99_750, amountCents: 19_751 }],
      totalCents: 227_651,
    });
    expect(discountBreakdown({ ...frozen, discount: { type: "fixed", label: "Courtesy", amount_cents: 22_000 } })?.discount.description).toBe("Courtesy");
  });

  it("is null without a discount or with anything malformed, so nothing extra is shown", () => {
    expect(discountBreakdown(null)).toBeNull();
    expect(discountBreakdown({ subtotal_cents: 220_000, tax_breakdown: [], total_cents: 252_945 })).toBeNull();
    expect(discountBreakdown({ ...frozen, discounted_subtotal_cents: -1 })).toBeNull();
    expect(discountBreakdown({ ...frozen, discount: { label: "x" } })).toBeNull();
  });
});
