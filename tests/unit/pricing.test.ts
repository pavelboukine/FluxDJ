import { describe, expect, it } from "vitest";
import {
  computeTaxBreakdown,
  offerSnapshotSchema,
  parseOfferSnapshot,
  priceSelection,
  roundedLineTax,
  type OfferSnapshot,
  type PricedSelection,
  type PricingResult,
} from "@/lib/pricing";
import { baseAnswers, demoOffer } from "./fixtures/offer";

function priced(result: PricingResult): PricedSelection {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.errors)}`);
  return result.selection;
}
function errorCodes(result: PricingResult): string[] {
  if (result.ok) throw new Error("expected failure");
  return result.errors.map((e) => `${e.code}@${e.path}`);
}
function line(selection: PricedSelection, key: string, source?: string) {
  return selection.lines.find((l) => l.item_key === key && (source === undefined || l.source === source));
}
const bothSeparate = { ...baseAnswers, ceremony_location: "separate_space", cocktail_location: "separate_space" };

describe("spec speaker example", () => {
  it("charges one extra speaker when two are required and Signature includes one", () => {
    const s = priced(priceSelection(demoOffer(), { package_key: "signature", answers: bothSeparate }));

    expect(s.requirements).toEqual([
      {
        gear_key: "additional_location_speaker",
        required_quantity: 2,
        included_quantity: 1,
        required_extra_quantity: 1,
        reasons: ["Separate ceremony space needs its own speaker.", "Separate cocktail space needs its own speaker."],
      },
    ]);
    expect(line(s, "additional_location_speaker", "required")).toMatchObject({
      quantity: 1,
      unit_price_cents: 15_000,
      line_total_cents: 15_000,
      required_quantity: 1,
    });
    expect(line(s, "additional_location_speaker", "included")).toMatchObject({ quantity: 1, line_total_cents: 0 });
    expect(s.subtotal_cents).toBe(235_000);
    expect(s.tax_breakdown).toEqual([
      { code: "GST", label: "GST", rate_ppm: 50_000, taxable_cents: 235_000, amount_cents: 11_750 },
      // 220000 * 9.975% = 21945; 15000 * 9.975% = 1496.25 -> 1496
      { code: "QST", label: "QST", rate_ppm: 99_750, taxable_cents: 235_000, amount_cents: 23_441 },
    ]);
    expect(s.tax_cents).toBe(35_191);
    expect(s.total_cents).toBe(270_191);
  });

  it("charges the speaker once when the client also selected one as an optional addon", () => {
    const withoutAddon = priced(priceSelection(demoOffer(), { package_key: "signature", answers: bothSeparate }));
    const withAddon = priced(
      priceSelection(demoOffer(), {
        package_key: "signature",
        answers: bothSeparate,
        addons: { additional_location_speaker: 1 },
      }),
    );
    const speakerLines = withAddon.lines.filter((l) => l.item_key === "additional_location_speaker" && l.line_total_cents > 0);
    expect(speakerLines).toHaveLength(1);
    expect(speakerLines[0]).toMatchObject({ source: "required", quantity: 1, required_quantity: 1 });
    expect(withAddon.total_cents).toBe(withoutAddon.total_cents);
    expect(withAddon.addon_quantities).toEqual({ additional_location_speaker: 1 });
  });

  it("allows more than the required minimum: chargeable = max(optional, required extra)", () => {
    const s = priced(
      priceSelection(demoOffer(), {
        package_key: "signature",
        answers: bothSeparate,
        addons: { additional_location_speaker: 3 },
      }),
    );
    expect(line(s, "additional_location_speaker", "required")).toMatchObject({ quantity: 3, required_quantity: 1 });
  });

  it("requires both speakers on a package that includes none", () => {
    const s = priced(
      priceSelection(demoOffer(), {
        package_key: "essential",
        answers: bothSeparate,
        addons: { additional_location_speaker: 1 },
      }),
    );
    expect(line(s, "additional_location_speaker", "required")).toMatchObject({ quantity: 2, required_quantity: 2 });
  });

  it("charges nothing extra when the package covers the requirement, but still honours optional extras", () => {
    const covered = priced(priceSelection(demoOffer(), { package_key: "premium", answers: bothSeparate }));
    expect(covered.requirements[0]).toMatchObject({ required_quantity: 2, included_quantity: 2, required_extra_quantity: 0 });
    expect(covered.lines.filter((l) => l.line_total_cents > 0).map((l) => l.item_key)).toEqual(["premium"]);

    const extra = priced(
      priceSelection(demoOffer(), { package_key: "premium", answers: bothSeparate, addons: { additional_location_speaker: 1 } }),
    );
    expect(line(extra, "additional_location_speaker", "optional")).toMatchObject({ quantity: 1, required_quantity: 0 });
  });

  it("never counts the main reception system as an additional-location speaker", () => {
    const s = priced(priceSelection(demoOffer(), { package_key: "essential", answers: bothSeparate }));
    expect(line(s, "main_sound_system", "included")).toMatchObject({ quantity: 1, line_total_cents: 0 });
    expect(line(s, "additional_location_speaker", "required")?.quantity).toBe(2);
  });

  it("adds no speaker when ceremony and cocktail share the reception room", () => {
    const s = priced(priceSelection(demoOffer(), { package_key: "essential", answers: baseAnswers }));
    expect(s.requirements).toEqual([]);
    expect(s.subtotal_cents).toBe(150_000);
  });

  it("does not charge for required gear the package already includes (wireless mic)", () => {
    const s = priced(
      priceSelection(demoOffer(), { package_key: "essential", answers: { ...baseAnswers, speeches_wireless_mic: true } }),
    );
    expect(s.requirements).toEqual([expect.objectContaining({ gear_key: "wireless_mic", required_extra_quantity: 0 })]);
    expect(line(s, "wireless_mic", "required")).toBeUndefined();
  });
});

describe("addon quantity bounds", () => {
  const price = (addons: Record<string, unknown>) =>
    priceSelection(demoOffer(), { package_key: "essential", answers: baseAnswers, addons });

  it("accepts 0 and the maximum", () => {
    expect(priced(price({ uplights_4: 0 })).addon_quantities).toEqual({});
    expect(line(priced(price({ uplights_4: 4 })), "uplights_4")).toMatchObject({ source: "optional", quantity: 4, line_total_cents: 48_000 });
  });

  it.each([
    ["above the maximum", 5],
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "2"],
    ["null", null],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a quantity that is %s", (_label, quantity) => {
    expect(errorCodes(price({ uplights_4: quantity }))).toEqual(["addon_quantity_invalid@addons.uplights_4"]);
  });
});

describe("missing answers", () => {
  it("rejects missing required answers instead of treating them as false", () => {
    const result = priceSelection(demoOffer(), { package_key: "signature", answers: { ceremony_location: "separate_space" } });
    expect(errorCodes(result)).toEqual([
      "answer_missing@answers.cocktail_location",
      "answer_missing@answers.speeches_wireless_mic",
    ]);
  });

  it("treats null as missing", () => {
    const result = priceSelection(demoOffer(), {
      package_key: "signature",
      answers: { ...baseAnswers, speeches_wireless_mic: null },
    });
    expect(errorCodes(result)).toEqual(["answer_missing@answers.speeches_wireless_mic"]);
  });

  it("rejects a selection with no answers at all", () => {
    expect(errorCodes(priceSelection(demoOffer(), { package_key: "signature" }))).toHaveLength(3);
  });

  it("allows optional questions to be skipped, and blank optional text counts as skipped", () => {
    const s = priced(
      priceSelection(demoOffer(), { package_key: "signature", answers: { ...baseAnswers, venue_notes: "   " } }),
    );
    expect(s.logistics_answers).toEqual(baseAnswers);
  });
});

describe("invalid selections", () => {
  it("rejects a package that is not offered", () => {
    expect(errorCodes(priceSelection(demoOffer(), { package_key: "platinum", answers: baseAnswers }))).toEqual([
      "package_not_offered@package_key",
    ]);
  });

  it("rejects addons that are not offered, including gear that exists in the offer but is not an addon", () => {
    const result = priceSelection(demoOffer(), {
      package_key: "essential",
      answers: baseAnswers,
      addons: { laser_show: 1, fog_machine: 1 },
    });
    expect(errorCodes(result)).toEqual(["addon_not_offered@addons.laser_show", "addon_not_offered@addons.fog_machine"]);
  });

  it("rejects answers to questions outside the offer and answers of the wrong shape", () => {
    const result = priceSelection(demoOffer(), {
      package_key: "essential",
      answers: {
        ceremony_location: "rooftop",
        cocktail_location: "same_room",
        speeches_wireless_mic: "yes",
        effects: ["fog", "fog"],
        favourite_colour: "blue",
      },
    });
    expect(errorCodes(result)).toEqual([
      "answer_unknown_question@answers.favourite_colour",
      "answer_invalid@answers.ceremony_location",
      "answer_invalid@answers.speeches_wireless_mic",
      "answer_invalid@answers.effects",
    ]);
  });

  it("collects every error in one pass", () => {
    const result = priceSelection(demoOffer(), { package_key: "nope", addons: { uplights_4: 99 }, answers: {} });
    expect(errorCodes(result)).toHaveLength(5);
  });

  it("rejects prototype keys rather than treating them as offered", () => {
    const addons = JSON.parse('{"__proto__": 1, "constructor": 1}');
    const result = priceSelection(demoOffer(), { package_key: "essential", answers: baseAnswers, addons });
    expect(result.ok).toBe(false);
  });
});

describe("client-supplied prices and totals are never trusted", () => {
  it.each([
    ["a total", { total_cents: 1 }],
    ["a subtotal", { subtotal_cents: 1 }],
    ["lines", { lines: [{ item_key: "essential", unit_price_cents: 1 }] }],
    ["a tax breakdown", { tax_breakdown: [] }],
  ])("rejects input that carries %s", (_label, extra) => {
    const result = priceSelection(demoOffer(), { package_key: "essential", answers: baseAnswers, ...extra });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)[0]).toMatch(/^input_invalid/);
  });

  it("rejects an addon expressed as a priced object", () => {
    const result = priceSelection(demoOffer(), {
      package_key: "essential",
      answers: baseAnswers,
      addons: { uplights_4: { quantity: 1, unit_price_cents: 1 } },
    });
    expect(errorCodes(result)).toEqual(["addon_quantity_invalid@addons.uplights_4"]);
  });

  it("takes every price from the frozen offer", () => {
    const s = priced(priceSelection(demoOffer(), { package_key: "essential", answers: baseAnswers, addons: { uplights_4: 2 } }));
    expect(line(s, "essential")?.unit_price_cents).toBe(150_000);
    expect(line(s, "uplights_4")?.unit_price_cents).toBe(12_000);
  });
});

describe("tax rounding", () => {
  it("rounds half up per line and per tax", () => {
    expect(roundedLineTax(10, 50_000)).toBe(1); // 0.5 -> 1
    expect(roundedLineTax(9, 50_000)).toBe(0); // 0.45 -> 0
    expect(roundedLineTax(30, 99_750)).toBe(3); // 2.9925 -> 3
    expect(roundedLineTax(25, 99_750)).toBe(2); // 2.49375 -> 2
    expect(roundedLineTax(15_000, 99_750)).toBe(1_496); // 1496.25 -> 1496
    expect(roundedLineTax(0, 99_750)).toBe(0);
  });

  it("stays exact for large amounts", () => {
    expect(roundedLineTax(10_000_000_000, 999_999)).toBe(9_999_990_000);
    expect(roundedLineTax(9_999_999_999, 99_750)).toBe(997_500_000); // 997499999.90025 -> 997500000
  });

  it("sums rounded line amounts rather than rounding the total", () => {
    const tax = demoOffer().tax;
    const breakdown = computeTaxBreakdown(
      [
        { line_total_cents: 10, tax_category: "standard" },
        { line_total_cents: 10, tax_category: "standard" },
      ],
      tax,
    );
    // Rounding the 20-cent total would give 1 cent of GST; the policy gives 2.
    expect(breakdown[0]).toEqual({ code: "GST", label: "GST", rate_ppm: 50_000, taxable_cents: 20, amount_cents: 2 });
  });

  it("applies taxes by category and lists every configured rate", () => {
    const s = priced(
      priceSelection(demoOffer(), { package_key: "essential", answers: { ...baseAnswers, effects: ["fog"] } }),
    );
    expect(line(s, "fog_machine", "required")).toMatchObject({ tax_category: "exempt", line_total_cents: 9_000 });
    expect(s.tax_breakdown.map((t) => t.taxable_cents)).toEqual([150_000, 150_000]);
    expect(s.subtotal_cents).toBe(159_000);
  });

  it("rejects invalid rates and totals", () => {
    expect(() => roundedLineTax(-1, 50_000)).toThrow(RangeError);
    expect(() => roundedLineTax(1, 1_000_001)).toThrow(RangeError);
    expect(() => roundedLineTax(1.5, 50_000)).toThrow(RangeError);
  });
});

describe("determinism and snapshot independence", () => {
  it("produces identical output for identical input, regardless of key order", () => {
    const a = priceSelection(demoOffer(), {
      package_key: "signature",
      answers: bothSeparate,
      addons: { uplights_4: 1, wireless_mic: 2 },
    });
    const b = priceSelection(demoOffer(), {
      addons: { wireless_mic: 2, uplights_4: 1 },
      answers: { speeches_wireless_mic: false, cocktail_location: "separate_space", ceremony_location: "separate_space" },
      package_key: "signature",
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("never mutates the offer it prices", () => {
    const offer = deepFreeze(demoOffer());
    expect(() => priceSelection(offer, { package_key: "signature", answers: bothSeparate, addons: { uplights_4: 2 } })).not.toThrow();
    expect(offer).toEqual(demoOffer());
  });

  it("prices only from the snapshot: a changed copy does not affect an earlier result", () => {
    const offer = demoOffer();
    const before = priced(priceSelection(offer, { package_key: "signature", answers: bothSeparate }));
    const changedCatalog = demoOffer();
    changedCatalog.gear.additional_location_speaker.unit_price_cents = 99_999;
    priceSelection(changedCatalog, { package_key: "signature", answers: bothSeparate });
    expect(priced(priceSelection(offer, { package_key: "signature", answers: bothSeparate }))).toEqual(before);
  });
});

describe("offer snapshot validation", () => {
  const invalid = (mutate: (o: OfferSnapshot) => void) => {
    const offer = demoOffer();
    mutate(offer);
    return offerSnapshotSchema.safeParse(offer).success;
  };

  it("accepts the demo offer", () => {
    expect(() => parseOfferSnapshot(demoOffer())).not.toThrow();
  });
  it("requires exactly three packages", () => {
    expect(invalid((o) => o.packages.pop())).toBe(false);
  });
  it("requires exactly one most-popular package", () => {
    expect(invalid((o) => (o.packages[0].is_popular = true))).toBe(false);
    expect(invalid((o) => (o.packages[1].is_popular = false))).toBe(false);
  });
  it("rejects rules that reference questions outside the offer", () => {
    expect(invalid((o) => o.questions.splice(0, 1))).toBe(false);
  });
  it("rejects rules whose condition does not fit the question", () => {
    expect(invalid((o) => (o.rules[0].condition = { op: "equals", value: "rooftop" }))).toBe(false);
  });
  it("rejects tax categories that do not resolve to the frozen configuration", () => {
    expect(invalid((o) => (o.gear.uplights_4.tax_category = "luxury"))).toBe(false);
    expect(invalid((o) => (o.packages[0].tax_category = "luxury"))).toBe(false);
    expect(invalid((o) => (o.tax.categories.standard = ["GST", "PST"]))).toBe(false);
  });
  it("rejects references to gear missing from the snapshot", () => {
    expect(invalid((o) => delete (o.gear as Record<string, unknown>).wireless_mic)).toBe(false);
  });
  it("rejects unexpected fields", () => {
    expect(invalid((o) => Object.assign(o, { discount_cents: 100 }))).toBe(false);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
