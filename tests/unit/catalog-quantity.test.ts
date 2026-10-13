import { describe, expect, it } from "vitest";
import { groupByCategory, missingSuggestions, normalizeCategoryName } from "@/lib/catalog/categories";
import { countText, perUnitText, piecesText, pluralUnit, quantityText } from "@/lib/catalog/quantity";
import { lineQuantityText } from "@/components/proposal/price-summary";
import { offerSnapshotSchema, parseOfferSnapshot, priceSelection, type PricedSelection } from "@/lib/pricing";
import { baseAnswers, demoOffer } from "./fixtures/offer";
import { QUANTITY_CASES } from "../support/quantity-cases";

const speaker = { name: "QSC K12.2 Speaker", unit_label: "speaker" };
const heads = { name: "Moving Heads", unit_label: "pair", pieces_per_unit: 2, piece_label: "lights" };
const tubes = { name: "LED Tubes", unit_label: "set", pieces_per_unit: 4, piece_label: "tubes" };

describe("gear quantity wording", () => {
  // The shared specification; the database's contract wording is checked against the same cases.
  it.each(QUANTITY_CASES)("$label", ({ gear, quantity, expected }) => {
    expect(quantityText(gear, quantity)).toBe(expected);
  });

  it("single-piece gear reads as before", () => {
    expect(quantityText(speaker, 1)).toBe("1 × QSC K12.2 Speaker");
    expect(quantityText(speaker, 2)).toBe("2 × QSC K12.2 Speaker");
    expect(countText(speaker, 2)).toBe("2");
    expect(piecesText(speaker, 2)).toBeNull();
    expect(perUnitText(speaker)).toBe("per speaker");
    // Older frozen offers have no pieces at all.
    expect(quantityText({ name: "Uplight", unit_label: "unit" }, 3)).toBe("3 × Uplight");
  });

  it("a pair of moving heads says how many lights, per sellable unit", () => {
    expect(quantityText(heads, 1)).toBe("1 pair of Moving Heads (2 lights)");
    // Two sellable pairs are four physical lights.
    expect(quantityText(heads, 2)).toBe("2 pairs of Moving Heads (4 lights)");
    expect(countText(heads, 2)).toBe("2 pairs (4 lights)");
    expect(perUnitText(heads)).toBe("per pair (2 lights)");
  });

  it("a set of four LED tubes", () => {
    expect(quantityText(tubes, 1)).toBe("1 set of LED Tubes (4 tubes)");
    expect(countText(tubes, 3)).toBe("3 sets (12 tubes)");
  });

  it("falls back sensibly for a default or multi-word unit and a missing piece label", () => {
    expect(quantityText({ name: "Uplights", unit_label: "unit", pieces_per_unit: 4, piece_label: "lights" }, 1)).toBe("1 × Uplights (4 lights)");
    expect(quantityText({ name: "Lighting kit", unit_label: "full kit", pieces_per_unit: 6, piece_label: null }, 2)).toBe("2 × Lighting kit (12 pieces)");
    expect(countText({ name: "Lighting kit", unit_label: "full kit", pieces_per_unit: 6 }, 1)).toBe("1 (6 pieces)");
  });

  it("pluralizes single-word units only", () => {
    expect(pluralUnit("pair", 2)).toBe("pairs");
    expect(pluralUnit("box", 2)).toBe("boxes");
    expect(pluralUnit("battery", 3)).toBe("batteries");
    expect(pluralUnit("pair", 1)).toBe("pair");
    expect(pluralUnit("set of 4", 2)).toBe("set of 4");
  });
});

describe("gear categories", () => {
  it("normalizes names", () => {
    expect(normalizeCategoryName("  Special   Effects ")).toBe("Special Effects");
    expect(normalizeCategoryName("   ")).toBeNull();
    expect(normalizeCategoryName("x".repeat(61))).toBeNull();
  });

  it("suggests only the defaults the business doesn't have", () => {
    expect(missingSuggestions([])).toEqual(["Audio", "Lighting", "Special Effects", "DJ Equipment", "Other"]);
    expect(missingSuggestions(["lighting", "Photo booth"])).toEqual(["Audio", "Special Effects", "DJ Equipment", "Other"]);
  });

  it("groups by category order, keeps item order, uncategorized last, no empty groups", () => {
    const lighting = { name: "Lighting", sort_order: 20 };
    const audio = { name: "Audio", sort_order: 10 };
    const items = [
      { id: "uplights", category: lighting },
      { id: "fog", category: null },
      { id: "sub", category: audio },
      { id: "heads", category: lighting },
      { id: "mic", category: audio },
    ];
    const groups = groupByCategory(items, (i) => i.category);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["Audio", ["sub", "mic"]],
      ["Lighting", ["uplights", "heads"]],
      [null, ["fog"]],
    ]);
    expect(groupByCategory([], () => null)).toEqual([]);
  });
});

describe("frozen offers with categories and pieces", () => {
  const offer = demoOffer();
  const withMetadata = {
    ...offer,
    gear: {
      ...offer.gear,
      uplights_4: { ...offer.gear.uplights_4, category: { name: "Lighting", sort_order: 20 }, pieces_per_unit: 4, piece_label: "lights" },
    },
  };

  it("parses the optional fields, and older offers without them", () => {
    expect(parseOfferSnapshot(withMetadata).gear.uplights_4.pieces_per_unit).toBe(4);
    expect(parseOfferSnapshot(offer).gear.uplights_4.category).toBeUndefined();
    // One piece is never frozen as a count (the database omits it).
    const one = { ...withMetadata, gear: { ...withMetadata.gear, uplights_4: { ...withMetadata.gear.uplights_4, pieces_per_unit: 1 } } };
    expect(offerSnapshotSchema.safeParse(one).success).toBe(false);
  });

  it("pieces never change prices: the charge stays per sellable unit", () => {
    const plain = priceSelection(offer, { package_key: "signature", addons: { uplights_4: 2 }, answers: baseAnswers });
    const pieces = priceSelection(parseOfferSnapshot(withMetadata), { package_key: "signature", addons: { uplights_4: 2 }, answers: baseAnswers });
    expect(plain.ok && pieces.ok).toBe(true);
    const a = (plain as { selection: PricedSelection }).selection;
    const b = (pieces as { selection: PricedSelection }).selection;
    expect(b.lines).toEqual(a.lines);
    expect(b.total_cents).toBe(a.total_cents);
    const line = b.lines.find((l) => l.item_key === "uplights_4" && l.source === "optional")!;
    expect(line).toMatchObject({ quantity: 2, unit_price_cents: 12_000, line_total_cents: 24_000 });
    expect(lineQuantityText(line, parseOfferSnapshot(withMetadata))).toBe("2 × Uplights (pack of 4) (8 lights)");
    expect(lineQuantityText(line, offer)).toBe("2 × Uplights (pack of 4)");
  });
});
