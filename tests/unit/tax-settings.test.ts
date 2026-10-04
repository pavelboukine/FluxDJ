import { describe, expect, it } from "vitest";
import { computeTaxBreakdown, priceSelection } from "@/lib/pricing";
import { needsTaxSetup, describeDbError } from "@/lib/db-errors";
import { parseTaxSettingsForm, percentToPpm, ppmToPercent, readTaxSettings, taxCodeFromLabel } from "@/lib/pricing/tax-settings";
import { baseAnswers, demoOffer } from "./fixtures/offer";

/** Builds the fields the Settings tax editor submits. */
function taxForm(taxes: { row: string; code?: string; label: string; rate: string }[], categories: Record<string, { mode: string; rows?: string[] }>) {
  const form = new FormData();
  for (const t of taxes) {
    form.append("tax_row", t.row);
    form.append(`tax_code:${t.row}`, t.code ?? "");
    form.append(`tax_label:${t.row}`, t.label);
    form.append(`tax_rate:${t.row}`, t.rate);
  }
  for (const [key, c] of Object.entries(categories)) {
    form.append("category", key);
    form.append(`category_mode:${key}`, c.mode);
    for (const r of c.rows ?? []) form.append(`category_tax:${key}`, r);
  }
  return form;
}

describe("percentToPpm: exact percentage to parts per million", () => {
  it.each([
    ["5", 50_000],
    ["9.975", 99_750],
    ["9,975", 99_750],
    ["14.975", 149_750],
    ["0.0001", 1],
    ["0", 0],
    ["0.1", 1_000],
    ["13", 130_000],
    ["100", 1_000_000],
    ["100.0000", 1_000_000],
    [" 7.5 ", 75_000],
  ])("%s%% -> %i ppm", (input, ppm) => {
    expect(percentToPpm(input)).toBe(ppm);
  });

  it("does not go through floating point (0.1 + 0.2 style errors)", () => {
    // 1.1 * 10000 is 11000.000000000002 in floating point.
    expect(percentToPpm("1.1")).toBe(11_000);
    expect(percentToPpm("4.35")).toBe(43_500);
    expect(percentToPpm("8.0005")).toBe(80_005);
  });

  it.each(["", " ", "abc", "5%", "-1", "+5", "1e2", "5.", ".5", "5..5", "5.12345", "100.0001", "101", "1000", "5 5", "Infinity", "NaN", "0x10", "٥"])(
    "rejects %j",
    (input) => {
      expect(percentToPpm(input)).toBeNull();
    },
  );

  it("round-trips with ppmToPercent", () => {
    for (const ppm of [0, 1, 10, 1_000, 50_000, 99_750, 149_750, 999_999, 1_000_000]) {
      expect(percentToPpm(ppmToPercent(ppm))).toBe(ppm);
    }
    expect(ppmToPercent(99_750)).toBe("9.975");
    expect(ppmToPercent(50_000)).toBe("5");
    expect(ppmToPercent(1)).toBe("0.0001");
    expect(() => ppmToPercent(1.5)).toThrow(RangeError);
    expect(() => ppmToPercent(1_000_001)).toThrow(RangeError);
  });
});

describe("taxCodeFromLabel", () => {
  it("derives an uppercase code and avoids collisions", () => {
    expect(taxCodeFromLabel("TPS / GST", new Set())).toBe("TPS_GST");
    expect(taxCodeFromLabel("Taxe é", new Set())).toBe("TAXE_E");
    expect(taxCodeFromLabel("GST", new Set(["GST"]))).toBe("GST_2");
    expect(taxCodeFromLabel("!!!", new Set())).toBe("TAX");
    expect(taxCodeFromLabel("A very long tax name indeed", new Set())).toMatch(/^[A-Z0-9_]{1,16}$/);
  });
});

describe("parseTaxSettingsForm", () => {
  it("maps multiple taxes to standard in tax-list order, assigning codes to new taxes", () => {
    const result = parseTaxSettingsForm(
      taxForm(
        [
          { row: "a", label: "GST", rate: "5" },
          { row: "b", label: "QST", rate: "9.975" },
        ],
        { standard: { mode: "taxes", rows: ["b", "a"] } },
      ),
    );
    expect(result).toEqual({
      ok: true,
      config: [
        { code: "GST", label: "GST", rate_ppm: 50_000 },
        { code: "QST", label: "QST", rate_ppm: 99_750 },
      ],
      categories: { standard: ["GST", "QST"] },
    });
  });

  it("keeps existing codes when a tax is renamed", () => {
    const result = parseTaxSettingsForm(taxForm([{ row: "t_GST", code: "GST", label: "TPS", rate: "5" }], { standard: { mode: "taxes", rows: ["t_GST"] } }));
    expect(result).toMatchObject({ ok: true, config: [{ code: "GST", label: "TPS", rate_ppm: 50_000 }], categories: { standard: ["GST"] } });
  });

  it("distinguishes explicit no tax from not configured", () => {
    const result = parseTaxSettingsForm(
      taxForm([{ row: "a", label: "GST", rate: "5" }], { standard: { mode: "none" }, exempt: { mode: "unset" } }),
    );
    expect(result).toMatchObject({ ok: true, categories: { standard: [] } });
    if (result.ok) expect("exempt" in result.categories).toBe(false);
  });

  it("requires a choice of taxes when 'Apply taxes' is selected", () => {
    const result = parseTaxSettingsForm(taxForm([{ row: "a", label: "GST", rate: "5" }], { standard: { mode: "taxes", rows: [] } }));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("Select at least one tax for the standard category") });
  });

  it("drops references to a removed tax instead of keeping a dangling code", () => {
    // The editor removes the row; a stale checkbox value for it is ignored.
    const result = parseTaxSettingsForm(taxForm([{ row: "a", label: "GST", rate: "5" }], { standard: { mode: "taxes", rows: ["a", "gone"] } }));
    expect(result).toMatchObject({ ok: true, categories: { standard: ["GST"] } });
  });

  it.each([
    [[{ row: "a", label: "GST", rate: "5.12345" }], "at most 4 decimals"],
    [[{ row: "a", label: "GST", rate: "101" }], "from 0 to 100"],
    [[{ row: "a", label: "GST", rate: "-5" }], "from 0 to 100"],
    [[{ row: "a", label: "GST", rate: "" }], "from 0 to 100"],
    [[{ row: "a", label: "", rate: "5" }], "1 to 40 characters"],
    [[{ row: "a", label: "x".repeat(41), rate: "5" }], "1 to 40 characters"],
    [[{ row: "a", label: "GST", rate: "5" }, { row: "b", label: "gst", rate: "6" }], "distinct names"],
    [[1, 2, 3, 4, 5, 6].map((n) => ({ row: `r${n}`, label: `T${n}`, rate: "1" })), "At most 5 taxes"],
    [[{ row: "a", code: "bad code", label: "GST", rate: "5" }], "Reload"],
  ])("rejects malformed taxes (%#)", (taxes, message) => {
    const result = parseTaxSettingsForm(taxForm(taxes, {}));
    expect(result).toEqual({ ok: false, message: expect.stringContaining(message) });
  });

  it("rejects malformed category keys and modes", () => {
    expect(parseTaxSettingsForm(taxForm([], { Standard: { mode: "none" } }))).toMatchObject({ ok: false });
    expect(parseTaxSettingsForm(taxForm([], { standard: { mode: "sometimes" } }))).toMatchObject({ ok: false });
  });
});

describe("pricing with configured settings", () => {
  it("applies two taxes to standard and none to an explicit no-tax category", () => {
    const tax = demoOffer().tax;
    const breakdown = computeTaxBreakdown(
      [
        { line_total_cents: 100_000, tax_category: "standard" },
        { line_total_cents: 50_000, tax_category: "exempt" },
      ],
      tax,
    );
    expect(breakdown).toEqual([
      { code: "GST", label: "GST", rate_ppm: 50_000, taxable_cents: 100_000, amount_cents: 5_000 },
      { code: "QST", label: "QST", rate_ppm: 99_750, taxable_cents: 100_000, amount_cents: 9_975 },
    ]);
  });

  it("treats a missing category as an error, never as zero tax", () => {
    const tax = { ...demoOffer().tax, categories: { exempt: [] } };
    expect(() => computeTaxBreakdown([{ line_total_cents: 100, tax_category: "standard" }], tax)).toThrow(/not configured/);
  });

  it("prices a whole selection with standard explicitly untaxed", () => {
    const offer = demoOffer();
    offer.tax = { ...offer.tax, categories: { standard: [], exempt: [] } };
    const result = priceSelection(offer, { package_key: "signature", answers: baseAnswers });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection.tax_cents).toBe(0);
      expect(result.selection.total_cents).toBe(result.selection.subtotal_cents);
    }
  });
});

describe("readTaxSettings and the configuration error", () => {
  it("reads stored jsonb defensively", () => {
    expect(readTaxSettings(null, null)).toEqual({ rates: [], categories: {} });
    expect(readTaxSettings([{ code: "GST", label: "GST", rate_ppm: 50_000 }, { bogus: true }], { standard: ["GST", 3] })).toEqual({
      rates: [{ code: "GST", label: "GST", rate_ppm: 50_000 }],
      categories: { standard: ["GST"] },
    });
  });

  it("points staff to Settings for a missing tax mapping only", () => {
    const missing = describeDbError({ code: "22023", message: "offer_invalid: tax categories not configured for this tenant: standard" });
    expect(missing).toMatch(/^This offer isn't ready: tax categories not configured for this tenant: standard\. .*Settings, under Taxes\.$/);
    expect(needsTaxSetup(missing)).toBe(true);
    const other = describeDbError({ code: "22023", message: "offer_invalid: exactly three packages are required" });
    expect(needsTaxSetup(other)).toBe(false);
  });
});
