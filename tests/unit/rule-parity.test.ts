import { describe, expect, it } from "vitest";
import { emailAddress, KEY_RE } from "@/lib/forms";
import { isHttpsUrl } from "@/lib/urls";
import { isEmail, isPhone } from "@/lib/planning/contacts";
import { isPlaylistUrl, PLAYLIST_LIMITS, playlistUrlKey } from "@/lib/planning/music";
import { discountCents, KEY_PATTERN, offerSnapshotSchema, readDiscount } from "@/lib/pricing";
import { parseTaxSettingsForm } from "@/lib/pricing/tax-settings";
import { parseMoneyToCents } from "@/lib/money";
import {
  ACCOUNT_EMAIL_CASES,
  CONTACT_EMAIL_CASES,
  DISCOUNT_CASES,
  DRAFT_DISCOUNT_CASES,
  HTTPS_URL_CASES,
  KEY_CASES,
  PHONE_CASES,
  PLAYLIST_KEY_CASES,
  RULE_CONDITION_CASES,
  RULE_CONDITION_OPTIONS,
  TAX_SETTINGS_CASES,
  taxForm,
} from "../support/rule-cases";

/**
 * The app's side of rules the database also enforces, against the shared
 * cases (tests/support/rule-cases.ts). tests/integration/rule-parity.test.ts
 * runs the database's functions against the same cases.
 */

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 70 ? `${s.slice(0, 50)}…(${s.length})` : s;
};

describe("field checks agree with the database", () => {
  it.each(HTTPS_URL_CASES.map((c) => [short(c.value), c] as const))("https address %s", (_, { value, valid, app }) => {
    const accepted = app ?? valid;
    expect(isHttpsUrl(value)).toBe(accepted);
    // Never accepts what the database refuses.
    if (accepted) expect(valid).toBe(true);
    // A playlist link is the same rule within its own length limit.
    expect(isPlaylistUrl(value)).toBe(accepted && value.length <= PLAYLIST_LIMITS.url);
  });

  it("every https address the app accepts is one a browser can parse", () => {
    for (const { value } of HTTPS_URL_CASES.filter((c) => isHttpsUrl(c.value))) expect(() => new URL(value), value).not.toThrow();
  });

  it.each(PHONE_CASES.map((c) => [short(c.value), c] as const))("phone %s", (_, { value, valid }) => {
    expect(isPhone(value)).toBe(valid);
  });

  it.each(CONTACT_EMAIL_CASES.map((c) => [short(c.value), c] as const))("planning contact email %s", (_, { value, valid }) => {
    expect(isEmail(value)).toBe(valid);
  });

  it.each(ACCOUNT_EMAIL_CASES.map((c) => [short(c.value), c] as const))("account email %s", (_, { value, valid, app }) => {
    const accepted = emailAddress(value);
    expect(accepted).toBe((app ?? valid) ? value : null);
    // Never accepts what the database refuses.
    if (accepted !== null) expect(valid).toBe(true);
  });

  it("account emails are trimmed and lowercased first, as the database stores them", () => {
    expect(emailAddress("  Robin.Client@Example.COM ")).toBe("robin.client@example.com");
    expect(emailAddress("")).toBeNull();
  });

  it.each(KEY_CASES.map((c) => [short(c.value), c] as const))("key %s", (_, { value, valid }) => {
    expect(KEY_RE.test(value)).toBe(valid);
    expect(KEY_PATTERN.test(value)).toBe(valid);
  });

  it.each(PLAYLIST_KEY_CASES.map((c) => [short(c.url), c] as const))("playlist key %s", (_, { url, key }) => {
    expect(playlistUrlKey(url)).toBe(key);
  });
});

/** A minimal valid offer whose only rule uses `condition` on a question of `answerType`. */
function offerWithRule(condition: unknown, answerType: (typeof RULE_CONDITION_CASES)[number]["answerType"]) {
  return {
    schema_version: 1,
    currency: "CAD",
    intro: null,
    expiry_days: 14,
    branding: { display_name: "IT", logo_storage_path: null, brand_colors: {} },
    tax: { rounding: "per_line_per_tax_half_up", rates: [], categories: { standard: [] } },
    packages: ["a", "b", "c"].map((key, i) => ({ key, name: key, description: null, base_price_cents: 1, tax_category: "standard", is_popular: i === 0, included: [] })),
    gear: { g: { key: "g", name: "G", description: null, unit_label: "unit", unit_price_cents: 1, tax_category: "standard", media: [] } },
    addons: [],
    questions: [{ key: "q", prompt: "Q", answer_type: answerType, options: RULE_CONDITION_OPTIONS(answerType), required: true }],
    rules: [{ question_key: "q", condition, gear_key: "g", required_quantity: 1, reason: "Needed" }],
  };
}

describe("frozen rule conditions agree with the database", () => {
  it.each(RULE_CONDITION_CASES.map((c) => [c.label, c] as const))("%s", (_, { condition, answerType, fits, app }) => {
    // The offer schema reads frozen offers: its answer is the database's, or (marked) more lenient.
    expect(offerSnapshotSchema.safeParse(offerWithRule(condition, answerType)).success).toBe(app ?? fits);
  });
});

describe("money limits and rounding agree with the database", () => {
  it.each(DISCOUNT_CASES.map((c) => [`${c.subtotal} with ${short(c.discount)}`, c] as const))("discount on %s", (_, { subtotal, discount, cents }) => {
    expect(discountCents(subtotal, discount)).toBe(cents);
  });

  it.each(DRAFT_DISCOUNT_CASES.map((c) => [c.label, c] as const))("draft discount: %s", (_, { fields, app, stored }) => {
    const read = readDiscount(fields, parseMoneyToCents);
    if (app === "refused") return expect(read.ok).toBe(false);
    expect(read).toEqual({ ok: true, discount: app === "none" ? null : stored });
  });

  it.each(TAX_SETTINGS_CASES.map((c) => [c.label, c] as const))("tax settings: %s", (_, c) => {
    expect(parseTaxSettingsForm(taxForm(c)).ok).toBe(c.app === "ok");
  });
});
