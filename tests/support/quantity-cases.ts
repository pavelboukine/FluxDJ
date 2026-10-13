/**
 * The one specification of gear quantity wording. Proposals use
 * quantityText (src/lib/catalog/quantity.ts); contracts are rendered in the
 * database with private.gear_quantity_text. Both are checked against these
 * cases (tests/unit/catalog-quantity.test.ts and
 * tests/integration/custom-prices.test.ts), so they cannot drift apart.
 *
 * `gear` is frozen offer gear: pieces appear only when a unit holds more
 * than one; older offers have no pieces at all.
 */
export type QuantityCase = {
  label: string;
  gear: { name: string; unit_label: string; pieces_per_unit?: number; piece_label?: string | null };
  quantity: number;
  expected: string;
};

export const QUANTITY_CASES: QuantityCase[] = [
  { label: "single item", gear: { name: "Speaker", unit_label: "speaker" }, quantity: 1, expected: "1 × Speaker" },
  { label: "single items, several", gear: { name: "QSC K12.2 Speaker", unit_label: "speaker" }, quantity: 2, expected: "2 × QSC K12.2 Speaker" },
  { label: "older offer (default unit, no pieces)", gear: { name: "Uplight", unit_label: "unit" }, quantity: 3, expected: "3 × Uplight" },
  { label: "a pair", gear: { name: "Moving Heads", unit_label: "pair", pieces_per_unit: 2, piece_label: "lights" }, quantity: 1, expected: "1 pair of Moving Heads (2 lights)" },
  { label: "two pairs", gear: { name: "Moving Heads", unit_label: "pair", pieces_per_unit: 2, piece_label: "lights" }, quantity: 2, expected: "2 pairs of Moving Heads (4 lights)" },
  { label: "a set of four", gear: { name: "LED Tubes", unit_label: "set", pieces_per_unit: 4, piece_label: "tubes" }, quantity: 1, expected: "1 set of LED Tubes (4 tubes)" },
  { label: "three sets", gear: { name: "LED Tubes", unit_label: "set", pieces_per_unit: 4, piece_label: "tubes" }, quantity: 3, expected: "3 sets of LED Tubes (12 tubes)" },
  { label: "plural -es", gear: { name: "Fog fluid", unit_label: "box", pieces_per_unit: 6, piece_label: "bottles" }, quantity: 2, expected: "2 boxes of Fog fluid (12 bottles)" },
  { label: "plural -ies", gear: { name: "Mic packs", unit_label: "battery", pieces_per_unit: 2, piece_label: "cells" }, quantity: 2, expected: "2 batteries of Mic packs (4 cells)" },
  { label: "default unit with pieces", gear: { name: "Uplights", unit_label: "unit", pieces_per_unit: 4, piece_label: "lights" }, quantity: 1, expected: "1 × Uplights (4 lights)" },
  { label: "multi-word unit, no piece label", gear: { name: "Lighting kit", unit_label: "full kit", pieces_per_unit: 6, piece_label: null }, quantity: 2, expected: "2 × Lighting kit (12 pieces)" },
  { label: "blank piece label", gear: { name: "Truss", unit_label: "set", pieces_per_unit: 2, piece_label: "  " }, quantity: 1, expected: "1 set of Truss (2 pieces)" },
];
