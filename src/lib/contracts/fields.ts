/**
 * Placeholders ("fields") in contract template text, for the editor, the
 * draft preview and the Word import. The database's registry
 * (private.contract_placeholders, read through contract_placeholder_catalog)
 * is the only source of valid keys and stays authoritative: it rejects
 * unknown or malformed placeholders on every save. This file only mirrors
 * its syntax so problems can be shown before saving.
 */

/** Same syntax as private.contract_placeholder_pattern(): {{key}} with optional inner spaces. */
export const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}/g;

export type CatalogField = { key: string; label: string; description: string; sort_order?: number };

/** Groups for the Insert field menu, by key prefix, in menu order. */
export const FIELD_GROUPS: { label: string; prefixes: string[] }[] = [
  { label: "Business", prefixes: ["business"] },
  { label: "Client", prefixes: ["client"] },
  { label: "Event and venue", prefixes: ["event", "venue"] },
  { label: "Package and gear", prefixes: ["package", "gear"] },
  { label: "Pricing", prefixes: ["pricing"] },
  { label: "Payment", prefixes: ["payment"] },
];

/** Fields that fill in several lines (a list); they read best on a line of their own. */
export const MULTILINE_FIELDS = new Set(["package.included", "gear.extras", "pricing.taxes"]);

export function groupFields<F extends CatalogField>(fields: F[]): { label: string; fields: F[] }[] {
  const groups = FIELD_GROUPS.map((g) => ({ label: g.label, fields: fields.filter((f) => g.prefixes.includes(f.key.split(".")[0])) }));
  const grouped = new Set(groups.flatMap((g) => g.fields.map((f) => f.key)));
  const other = fields.filter((f) => !grouped.has(f.key));
  return [...groups, ...(other.length ? [{ label: "Other", fields: other }] : [])].filter((g) => g.fields.length > 0);
}

/**
 * Example values for the draft preview, shaped like the values contract
 * generation fills in (lists as "- " lines). Clearly examples: no real
 * client, event or price is read.
 */
export const EXAMPLE_VALUES: Record<string, string> = {
  "business.name": "Example DJ Services Inc.",
  "business.legal_name": "Example DJ Services Inc.",
  "business.display_name": "Example DJ",
  "business.address": "123 Example Street, Gatineau, QC J9H 0A0",
  "business.email": "hello@example.com",
  "client.name": "Alex Example",
  "client.email": "alex@example.com",
  "client.phone": "819-555-0100",
  "event.title": "Alex & Sam's wedding",
  "event.date": "Saturday, June 12, 2027",
  "venue.name": "Example Hall",
  "venue.address": "1 Example Road, Ottawa, ON K1A 0A1",
  "package.name": "Signature",
  "package.price": "2,000.00 CAD",
  "package.included": "- 1 × Main sound system\n- 1 × Wireless microphone",
  "gear.extras": "- 4 × Uplights: 200.00 CAD",
  "pricing.subtotal_before_discount": "2,200.00 CAD",
  "pricing.discount": "No discount.",
  "pricing.subtotal": "2,200.00 CAD",
  "pricing.taxes": "- GST (5%): 110.00 CAD\n- QST (9.975%): 219.45 CAD",
  "pricing.tax_total": "329.45 CAD",
  "pricing.total": "2,529.45 CAD",
  "pricing.currency": "CAD",
  "payment.deposit_percent": "50%",
  "payment.deposit": "1,264.73 CAD",
  "payment.balance": "1,264.72 CAD",
  "payment.balance_due_date": "June 1, 2027",
};

/** Replaces known fields with example values; anything else is left exactly as typed. */
export function fillExamples(text: string, known: ReadonlySet<string>, values: Record<string, string> = EXAMPLE_VALUES): string {
  return text.replace(PLACEHOLDER_RE, (match, key: string) => (known.has(key) && values[key] !== undefined ? values[key] : match));
}

export type PlaceholderScan = { known: string[]; unknown: string[]; malformed: string[] };

/** The fields a text uses, as the database would judge them: known keys, unknown keys, and stray "{{" or "}}". */
export function scanPlaceholders(text: string, known: ReadonlySet<string>): PlaceholderScan {
  const found = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  // Anything else with "{{" or "}}", as typed: "{{Client Name}}", a lone "{{".
  const malformed = [...text.matchAll(/\{\{[^{}\n]{0,60}\}\}|\{\{|\}\}/g)]
    .map((m) => m[0])
    .filter((m) => !new RegExp(`^${PLACEHOLDER_RE.source}$`).test(m));
  return {
    known: [...new Set(found.filter((k) => known.has(k)))],
    unknown: [...new Set(found.filter((k) => !known.has(k)))],
    malformed: [...new Set(malformed)],
  };
}
