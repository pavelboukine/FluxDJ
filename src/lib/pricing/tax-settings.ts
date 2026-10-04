import { KEY_RE } from "@/lib/forms";

/**
 * Tax settings as stored on the tenant (and copied into offer snapshots):
 *   tax_config:     [{ code, label, rate_ppm }]   rate_ppm: 1% = 10,000 ppm
 *   tax_categories: { [categoryKey]: code[] }      [] = explicitly no tax
 * A category missing from tax_categories is "not configured" and blocks
 * offers that use it; it never means zero tax.
 */
export type TaxRate = { code: string; label: string; rate_ppm: number };
export type TaxCategories = Record<string, string[]>;

export const MAX_TAXES = 5;
export const MAX_TAX_CATEGORIES = 20;
const PPM_PER_PERCENT = 10_000;

/**
 * Converts a percentage typed by a person ("5", "9.975", "9,975") to integer
 * parts per million, exactly: the digits are read as a string, never through
 * floating point. Four decimals is the most that maps exactly to ppm, so more
 * are refused rather than rounded. Returns null for anything malformed or
 * outside 0-100%.
 */
export function percentToPpm(input: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(input.trim());
  if (!match) return null;
  const ppm = Number(match[1]) * PPM_PER_PERCENT + Number((match[2] ?? "").padEnd(4, "0"));
  return ppm <= 1_000_000 ? ppm : null;
}

/** Exact inverse of percentToPpm for display and form values: 99750 -> "9.975". */
export function ppmToPercent(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) throw new RangeError("invalid rate");
  const whole = Math.floor(ppm / PPM_PER_PERCENT);
  const fraction = String(ppm % PPM_PER_PERCENT).padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** A stable internal code from a tax name: "TVQ / QST" -> "TVQ_QST", unique among `taken`. */
export function taxCodeFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 16) || "TAX";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 16 - String(n).length - 1)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Reads stored settings defensively (they are jsonb). */
export function readTaxSettings(config: unknown, categories: unknown): { rates: TaxRate[]; categories: TaxCategories } {
  const rates = Array.isArray(config)
    ? config.filter(
        (r): r is TaxRate => !!r && typeof r.code === "string" && typeof r.label === "string" && Number.isInteger(r.rate_ppm),
      )
    : [];
  const mapping: TaxCategories = {};
  if (categories && typeof categories === "object" && !Array.isArray(categories)) {
    for (const [key, codes] of Object.entries(categories)) {
      if (Array.isArray(codes)) mapping[key] = codes.filter((c): c is string => typeof c === "string");
    }
  }
  return { rates, categories: mapping };
}

export type CategoryMode = "unset" | "none" | "taxes";

/** How many active gear items and packages use a tax category. */
export type CategoryUsage = { key: string; gear: number; packages: number };

export function usageText(u: CategoryUsage | undefined): string {
  if (!u || (u.gear === 0 && u.packages === 0)) return "Not used by active gear or packages.";
  const parts = [u.gear ? `${u.gear} gear item${u.gear === 1 ? "" : "s"}` : null, u.packages ? `${u.packages} package${u.packages === 1 ? "" : "s"}` : null];
  return `Used by ${parts.filter(Boolean).join(" and ")}.`;
}

/*
 * Form fields written by the Settings tax editor:
 *   tax_row               one per tax, a client-side row id, in display order
 *   tax_code:<row>        the existing code, or empty for a new tax
 *   tax_label:<row>       name shown to clients
 *   tax_rate:<row>        percentage, e.g. 9.975
 *   category              one per category key shown
 *   category_mode:<key>   unset | none | taxes
 *   category_tax:<key>    one per selected tax row id (mode "taxes")
 */
export function parseTaxSettingsForm(
  form: FormData,
): { ok: true; config: TaxRate[]; categories: TaxCategories } | { ok: false; message: string } {
  const strings = (name: string) => form.getAll(name).filter((v): v is string => typeof v === "string");
  const one = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v.trim() : "";
  };

  const rows = strings("tax_row");
  if (rows.length > MAX_TAXES) return { ok: false, message: `At most ${MAX_TAXES} taxes can be configured.` };
  if (new Set(rows).size !== rows.length) return { ok: false, message: "Reload the page and try again." };

  const existing = rows.map((row) => one(`tax_code:${row}`)).filter(Boolean);
  const taken = new Set(existing);
  const config: TaxRate[] = [];
  const codeByRow = new Map<string, string>();
  const labels = new Set<string>();
  for (const row of rows) {
    const label = one(`tax_label:${row}`).replace(/\s+/g, " ");
    if (label.length < 1 || label.length > 40) return { ok: false, message: "Each tax needs a name of 1 to 40 characters." };
    if (labels.has(label.toLowerCase())) return { ok: false, message: `Two taxes are named “${label}”. Use distinct names.` };
    labels.add(label.toLowerCase());
    const rawRate = one(`tax_rate:${row}`);
    const ratePpm = percentToPpm(rawRate);
    if (ratePpm === null) {
      return {
        ok: false,
        message: `The rate for ${label} must be a percentage from 0 to 100 with at most 4 decimals (for example 9.975).`,
      };
    }
    let code = one(`tax_code:${row}`);
    if (code && !/^[A-Z0-9_]{1,16}$/.test(code)) return { ok: false, message: "Reload the page and try again." };
    if (!code) {
      code = taxCodeFromLabel(label, taken);
      taken.add(code);
    }
    codeByRow.set(row, code);
    config.push({ code, label, rate_ppm: ratePpm });
  }

  const keys = strings("category").map((k) => k.trim());
  if (new Set(keys).size !== keys.length) return { ok: false, message: "A tax category is listed twice." };
  const categories: TaxCategories = {};
  for (const key of keys) {
    if (!KEY_RE.test(key)) {
      return { ok: false, message: `“${key}” isn't a valid category key. Use lowercase letters, digits and underscores, starting with a letter.` };
    }
    const mode = one(`category_mode:${key}`) as CategoryMode;
    if (mode === "unset") continue;
    if (mode === "none") {
      categories[key] = [];
      continue;
    }
    if (mode !== "taxes") return { ok: false, message: `Choose how the ${key} category is taxed.` };
    const codes: string[] = [];
    for (const row of strings(`category_tax:${key}`)) {
      const code = codeByRow.get(row);
      if (code && !codes.includes(code)) codes.push(code);
    }
    if (codes.length === 0) {
      return { ok: false, message: `Select at least one tax for the ${key} category, or choose “No tax”.` };
    }
    // Keep the tax list's order, so breakdowns read the same everywhere.
    categories[key] = config.map((r) => r.code).filter((c) => codes.includes(c));
  }
  if (Object.keys(categories).length > MAX_TAX_CATEGORIES) {
    return { ok: false, message: `At most ${MAX_TAX_CATEGORIES} tax categories can be configured.` };
  }
  return { ok: true, config, categories };
}
