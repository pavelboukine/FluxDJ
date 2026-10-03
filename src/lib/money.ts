/**
 * Money helpers. Amounts are integer cents everywhere; these convert to and
 * from what staff type and see. Parsing never goes through floating point.
 */

const MONEY_PATTERN = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** "1500", "1,500.5", "$1500.50" -> cents. Returns null for anything else. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/[,\s]/g, "");
  const match = MONEY_PATTERN.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents -> "150.00", the value shown back in an input. */
export function centsToInputValue(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents -> localized currency string, e.g. "$1,500.00". */
export function formatCents(cents: number, currency = "CAD", locale = "en-CA"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
