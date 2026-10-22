/**
 * The database's side of rules the app also enforces: the real functions in
 * the LOCAL database (read-only, IMMUTABLE checks; no rows are touched)
 * against the shared cases in tests/support/rule-cases.ts, which
 * tests/unit/rule-parity.test.ts runs against the app's functions. Where the
 * app produces a value (a draft discount, tax settings), the database checks
 * exactly that value.
 */
import { describe, expect, it } from "vitest";
import { readDiscount } from "@/lib/pricing";
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
import { sql } from "./support/sql";

/** A dollar-quoted literal; the cases never contain the delimiter. */
function literal(value: string): string {
  if (value.includes("$c$")) throw new Error("case contains the quote delimiter");
  return `$c$${value}$c$`;
}
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;

/** One query per case, one output line each (a null prints as an empty line). */
function each(queries: string[]): string[] {
  const out = sql(queries.map((q) => `select coalesce((${q})::text, '<null>');`).join("\n")).split("\n");
  expect(out).toHaveLength(queries.length);
  return out;
}
const bool = (q: string) => `coalesce(${q}, false)`;

describe("database checks agree with the app (local Supabase)", () => {
  it("https addresses: private.is_https_url", () => {
    const got = each(HTTPS_URL_CASES.map((c) => bool(`private.is_https_url(${literal(c.value)})`)));
    HTTPS_URL_CASES.forEach((c, i) => expect(got[i], c.value.slice(0, 60)).toBe(String(c.valid)));
  });

  it("phones and planning contact emails: private.is_phone and private.is_email", () => {
    const phones = each(PHONE_CASES.map((c) => bool(`private.is_phone(${literal(c.value)})`)));
    PHONE_CASES.forEach((c, i) => expect(phones[i], JSON.stringify(c.value)).toBe(String(c.valid)));
    const emails = each(CONTACT_EMAIL_CASES.map((c) => bool(`private.is_email(${literal(c.value)})`)));
    CONTACT_EMAIL_CASES.forEach((c, i) => expect(emails[i], JSON.stringify(c.value).slice(0, 60)).toBe(String(c.valid)));
  });

  it("account emails: private.is_valid_email", () => {
    const got = each(ACCOUNT_EMAIL_CASES.map((c) => bool(`private.is_valid_email(${literal(c.value)})`)));
    ACCOUNT_EMAIL_CASES.forEach((c, i) => expect(got[i], c.value.slice(0, 60)).toBe(String(c.valid)));
  });

  it("keys: private.is_valid_key", () => {
    const got = each(KEY_CASES.map((c) => bool(`private.is_valid_key(${literal(c.value)})`)));
    KEY_CASES.forEach((c, i) => expect(got[i], JSON.stringify(c.value)).toBe(String(c.valid)));
  });

  it("playlist keys: private.playlist_url_key", () => {
    const got = each(PLAYLIST_KEY_CASES.map((c) => `private.playlist_url_key(${literal(c.url)})`));
    PLAYLIST_KEY_CASES.forEach((c, i) => expect(got[i], c.url).toBe(c.key ?? "<null>"));
  });

  it("frozen rule conditions: private.is_valid_rule_condition, then private.rule_condition_fits_question", () => {
    // fits_question assumes a valid condition (it can raise on a malformed one), as every caller checks validity first.
    const got = each(
      RULE_CONDITION_CASES.map(
        (c) =>
          `case when ${bool(`private.is_valid_rule_condition(${json(c.condition)})`)} then ${bool(`private.rule_condition_fits_question(${json(c.condition)}, ${literal(c.answerType)}, ${json(RULE_CONDITION_OPTIONS(c.answerType))})`)} else false end`,
      ),
    );
    RULE_CONDITION_CASES.forEach((c, i) => expect(got[i], c.label).toBe(String(c.fits)));
  });

  it("discount rounding: private.offer_discount_cents", () => {
    const got = each(DISCOUNT_CASES.map((c) => `private.offer_discount_cents(jsonb_build_object('discount', ${json(c.discount)}), ${c.subtotal})`));
    DISCOUNT_CASES.forEach((c, i) => expect(got[i], `${c.subtotal} ${JSON.stringify(c.discount)}`).toBe(String(c.cents)));
  });

  it("draft discounts: what the app would store passes private.is_valid_discount; what it refuses doesn't", () => {
    const checked = DRAFT_DISCOUNT_CASES.filter((c) => c.stored);
    for (const c of checked) {
      const read = readDiscount(c.fields, parseMoneyToCents);
      // The value checked is the app's own output wherever the app accepts.
      if (c.app === "ok") expect(read).toEqual({ ok: true, discount: c.stored });
    }
    const got = each(checked.map((c) => bool(`private.is_valid_discount(${json(c.stored)})`)));
    checked.forEach((c, i) => expect(got[i], c.label).toBe(String(c.valid)));
  });

  it("tax settings: what the app would store passes the tenants table's checks; what it refuses doesn't", () => {
    const stored = TAX_SETTINGS_CASES.map((c) => {
      const parsed = parseTaxSettingsForm(taxForm(c));
      expect(parsed.ok, c.label).toBe(c.app === "ok");
      return parsed.ok ? { config: parsed.config, categories: parsed.categories } : c.stored!;
    });
    const got = each(stored.map((s) => bool(`private.is_valid_tax_config(${json(s.config)}) and private.is_valid_tax_categories(${json(s.config)}, ${json(s.categories)})`)));
    TAX_SETTINGS_CASES.forEach((c, i) => expect(got[i], c.label).toBe(String(c.valid)));
  });
});
