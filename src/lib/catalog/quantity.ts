/**
 * How quantities of gear read to clients and staff. A gear item is one
 * sellable unit ("Moving Heads", sold by the pair) that may hold several
 * physical pieces (2 lights). Quantities everywhere count sellable units and
 * prices stay per sellable unit; the pieces only make the wording honest:
 * "1 pair of Moving Heads (2 lights)" instead of "1 × Moving Heads".
 *
 * Works with frozen offer gear (pieces only present when more than one) and
 * with catalog rows (pieces_per_unit 1 by default).
 */
export type UnitInfo = {
  name: string;
  unit_label: string;
  pieces_per_unit?: number | null;
  piece_label?: string | null;
};

const DEFAULT_PIECE_LABEL = "pieces";

export function piecesPerUnit(gear: Pick<UnitInfo, "pieces_per_unit">): number {
  const n = gear.pieces_per_unit ?? 1;
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** "pair" → "pairs", "box" → "boxes", "battery" → "batteries"; only single words change. */
export function pluralUnit(unit: string, count: number): string {
  const word = unit.trim();
  if (count === 1 || !/^[a-z]+$/i.test(word)) return word;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** The sellable unit as a word, when it is one ("pair", "set"); multi-word labels read better as "×". */
function unitWord(gear: UnitInfo): string | null {
  const unit = gear.unit_label.trim();
  return /^[a-z]+$/i.test(unit) ? unit : null;
}

/** "4 lights" for `quantity` units of multi-piece gear; null when each unit is a single piece. */
export function piecesText(gear: UnitInfo, quantity: number): string | null {
  const pieces = piecesPerUnit(gear);
  if (pieces === 1) return null;
  return `${quantity * pieces} ${gear.piece_label?.trim() || DEFAULT_PIECE_LABEL}`;
}

/**
 * The count alone, for places that show the name separately: "2" for
 * single-piece gear, "1 pair (2 lights)" for multi-piece gear.
 */
export function countText(gear: UnitInfo, quantity: number): string {
  const pieces = piecesText(gear, quantity);
  if (!pieces) return String(quantity);
  const unit = unitWord(gear);
  return unit ? `${quantity} ${pluralUnit(unit, quantity)} (${pieces})` : `${quantity} (${pieces})`;
}

/**
 * Quantity and name: "2 × Speaker", "1 pair of Moving Heads (2 lights)",
 * "2 pairs of Moving Heads (4 lights)".
 */
export function quantityText(gear: UnitInfo, quantity: number): string {
  const pieces = piecesText(gear, quantity);
  if (!pieces) return `${quantity} × ${gear.name}`;
  const unit = unitWord(gear);
  return unit && unit.toLowerCase() !== "unit"
    ? `${quantity} ${pluralUnit(unit, quantity)} of ${gear.name} (${pieces})`
    : `${quantity} × ${gear.name} (${pieces})`;
}

/** What one price buys: "per speaker", "per pair (2 lights)". */
export function perUnitText(gear: UnitInfo): string {
  const pieces = piecesText(gear, 1);
  return `per ${gear.unit_label.trim()}${pieces ? ` (${pieces})` : ""}`;
}
