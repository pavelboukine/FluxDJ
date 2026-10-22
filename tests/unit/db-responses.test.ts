import { afterEach, describe, expect, it, vi } from "vitest";
import { clientContractViewSchema, contractReviewSchema, generateContractResultSchema, signContractResultSchema } from "@/lib/contracts/responses";
import { centsSchema, checkDbResponse, DbResponseError, parseDbResponse, timestampSchema } from "@/lib/db-response";
import { clientPaymentSummarySchema, discountBreakdown, paymentSummarySchema, readPaymentSummary } from "@/lib/payments";
import { priceSelection, pricedSelectionSchema, selectionRecordSchema, toSelectionRecord } from "@/lib/pricing";
import { baseAnswers, demoOffer } from "./fixtures/offer";

/**
 * Database responses at trust boundaries (lib/db-response.ts): the shapes
 * the database returns parse; anything else fails, and a failure says where
 * and what kind, never the values. tests/integration/db-responses.test.ts
 * parses the real local database's answers with the same schemas.
 */

const ID = "5b0f1c2e-8f4a-4d3b-9c1e-2a7f6e5d4c3b";
const HASH = "a".repeat(64);
const AT = "2026-10-22T17:11:12.123456+00:00";

function sentView() {
  return {
    state: "available",
    brand: { display_name: "IT Sound", brand_colors: { primary: "#112233" } },
    contract: {
      id: ID, status: "sent", sent_at: AT, content_sha256: HASH, rendered_content: { schema_version: 1, title: "T", sections: [] },
      signer_name: "Robin Client", currency: "CAD", total_cents: 243_173, deposit_percent: 50, deposit_cents: 121_587, balance_cents: 121_586,
      balance_due_date: "2027-06-01", signing_mode: "demo", event_title: "Wedding", event_date: "2027-06-12", legal_name: "IT Sound Inc.",
    },
    signing: { signed: false, enabled: true, consent_version: "demo-v1", consent_text: "I agree." },
  };
}
function signedView() {
  const v = sentView();
  return { ...v, contract: { ...v.contract, status: "signed" }, signing: { signed: true, typed_name: "Robin Client", signed_at: AT, pdf_ready: false, pdf_pending: true } };
}
function staffSummary() {
  return {
    currency: "CAD",
    terms: { status: "signed", contract_id: ID, total_cents: 243_173, deposit_percent: 50, deposit_cents: 121_587, balance_cents: 121_586, balance_due_date: null },
    received_cents: 100_000, valid_payments: 1, other_currency_payments: 0,
    deposit_outstanding_cents: 21_587, remaining_balance_cents: 143_173, credit_cents: 0, invoice_url: null,
    booking: { lifecycle_status: "awaiting_deposit", booking_confirmed_at: null, policy: "on_deposit", legacy_signed: false, deposit_no_longer_met: false },
  };
}
const pricing = {
  subtotal_cents: 235_000,
  discount: { type: "percent", label: "Wedding Special", percent_basis_points: 1000, amount_cents: 23_500 },
  discounted_subtotal_cents: 211_500,
  tax_breakdown: [{ label: "GST", rate_ppm: 50_000, amount_cents: 10_575 }, { label: "QST", rate_ppm: 99_750, amount_cents: 21_098 }],
  total_cents: 243_173,
};
function clientSummary() {
  return {
    currency: "CAD", terms_status: "signed", total_cents: 243_173, deposit_percent: 50, deposit_cents: 121_587, balance_due_date: null,
    received_cents: 121_587, deposit_outstanding_cents: 0, remaining_balance_cents: 121_586, credit_cents: 0, invoice_url: null, booking_status: "booked",
  };
}

/** The JSON lines written while running `fn`. */
function logged(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("shared field schemas", () => {
  it("accepts only non-negative safe integer cents", () => {
    for (const ok of [0, 1, 243_173, Number.MAX_SAFE_INTEGER]) expect(centsSchema.safeParse(ok).success).toBe(true);
    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN, Infinity, "100", null]) expect(centsSchema.safeParse(bad).success).toBe(false);
  });

  it("reads timestamps as Postgres writes them in JSON", () => {
    for (const ok of [AT, "2026-10-22T17:11:12+00:00", "2026-10-22T17:11:12.5-04:00"]) expect(timestampSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", "yesterday", 1_700_000_000]) expect(timestampSchema.safeParse(bad).success).toBe(false);
  });
});

describe("failures are logged without values", () => {
  it("logs the function, field paths and issue codes, never what was received", () => {
    const view = sentView();
    const leaky = { ...view, contract: { ...view.contract, total_cents: "243173.00", signer_name: 42, signer_email: "robin@example.com" } };
    const lines = logged(() => expect(checkDbResponse(clientContractViewSchema, leaky, "client_contract_view").ok).toBe(false));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ source: "flux-dj", level: "error", category: "data", operation: "client_contract_view", code: "invalid_response" });
    expect(line.detail).toContain("contract.total_cents: invalid_type");
    expect(lines[0]).not.toMatch(/243173|robin|example\.com|Robin Client|IT Sound/);
  });

  it("throws a named error whose message carries the same safe summary", () => {
    let thrown: unknown;
    logged(() => {
      try {
        parseDbResponse(signContractResultSchema, { status: "signed", replayed: false, typed_name: "Robin Client" }, "sign_contract");
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBeInstanceOf(DbResponseError);
    expect((thrown as Error).name).toBe("DbResponseError");
    expect((thrown as Error).message).toMatch(/^sign_contract returned an unexpected response \(.*contract_id: invalid_type/);
    expect((thrown as Error).message).not.toContain("Robin");
  });

  it("caps the summary at five issues", () => {
    const lines = logged(() => checkDbResponse(paymentSummarySchema, { booking: {} }, "event_payment_summary"));
    expect(JSON.parse(lines[0]).detail).toMatch(/; \+\d+ more$/);
  });
});

describe("client_contract_view", () => {
  it("parses sent, signed and unavailable views", () => {
    expect(clientContractViewSchema.parse(sentView())).toMatchObject({ state: "available", signing: { signed: false, enabled: true } });
    expect(clientContractViewSchema.parse(signedView())).toMatchObject({ signing: { signed: true, typed_name: "Robin Client" } });
    expect(clientContractViewSchema.parse({ state: "unavailable" })).toEqual({ state: "unavailable" });
    // A contract generated from a legacy template version can't be signed online.
    const legacy = sentView();
    expect(clientContractViewSchema.safeParse({ ...legacy, contract: { ...legacy.contract, signing_mode: "none" }, signing: { signed: false, enabled: false, consent_version: null, consent_text: null } }).success).toBe(true);
  });

  it("parses the deposit boundaries the database allows: none, all of it, and a $0 contract", () => {
    const v = sentView();
    const terms = (total_cents: number, deposit_percent: number, deposit_cents: number) => ({ ...v, contract: { ...v.contract, total_cents, deposit_percent, deposit_cents, balance_cents: total_cents - deposit_cents } });
    for (const value of [terms(243_173, 0, 0), terms(243_173, 100, 243_173), terms(0, 50, 0)]) expect(clientContractViewSchema.safeParse(value).success).toBe(true);
    const s = staffSummary();
    expect(paymentSummarySchema.safeParse({ ...s, terms: { ...s.terms, total_cents: 0, deposit_cents: 0, balance_cents: 0 }, deposit_outstanding_cents: 0, remaining_balance_cents: 0, credit_cents: 100_000 }).success).toBe(true);
  });

  it("refuses unsafe money, terms that don't add up and a signing state that contradicts the status", () => {
    const v = sentView();
    const bad = [
      { ...v, contract: { ...v.contract, total_cents: 243_173.5 } },
      { ...v, contract: { ...v.contract, deposit_cents: -1 } },
      { ...v, contract: { ...v.contract, balance_cents: 121_000 } },
      { ...v, contract: { ...v.contract, currency: "cad" } },
      { ...v, contract: { ...v.contract, deposit_percent: 101 } },
      { ...v, contract: { ...v.contract, status: "void" } },
      { ...v, contract: { ...v.contract, id: undefined } },
      { ...v, signing: { signed: true, typed_name: "Robin", signed_at: AT, pdf_ready: false, pdf_pending: false } },
      { ...signedView(), signing: { signed: false, enabled: true, consent_version: null, consent_text: null } },
      { ...signedView(), signing: { signed: true, signed_at: AT, pdf_ready: false, pdf_pending: false } },
      { state: "available" },
      { state: "maybe" },
      null,
    ];
    for (const value of bad) expect(clientContractViewSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe("sign_contract", () => {
  it("parses a signature, a replay and a rejection, and refuses a signed answer missing what the client is shown", () => {
    expect(signContractResultSchema.parse({ status: "signed", replayed: false, contract_id: ID, signed_at: AT, typed_name: "Robin" })).toMatchObject({ contract_id: ID });
    expect(signContractResultSchema.parse({ status: "signed", replayed: true, contract_id: ID, signed_at: AT, typed_name: "Robin" })).toMatchObject({ replayed: true });
    expect(signContractResultSchema.parse({ status: "rejected", code: "content_changed", message: "Reload." })).toMatchObject({ code: "content_changed" });
    for (const bad of [
      { status: "signed", replayed: false, contract_id: ID, typed_name: "Robin" },
      { status: "signed", contract_id: ID, signed_at: AT, typed_name: "Robin" },
      { status: "rejected", code: "unavailable" },
      { status: "ok" },
    ]) expect(signContractResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe("payment summaries", () => {
  it("parses the staff summary with and without contract terms, keeping an unknown lifecycle status readable", () => {
    expect(paymentSummarySchema.parse(staffSummary()).terms?.deposit_cents).toBe(121_587);
    const noTerms = { ...staffSummary(), terms: null, deposit_outstanding_cents: null, remaining_balance_cents: null, credit_cents: null };
    expect(paymentSummarySchema.parse(noTerms).terms).toBeNull();
    const future = staffSummary();
    expect(paymentSummarySchema.safeParse({ ...future, booking: { ...future.booking, lifecycle_status: "postponed" } }).success).toBe(true);
  });

  it("refuses wrong money, an unknown policy and terms that don't add up", () => {
    const s = staffSummary();
    for (const bad of [
      { ...s, received_cents: "100000" },
      { ...s, received_cents: 100_000.01 },
      { ...s, deposit_outstanding_cents: -5 },
      { ...s, terms: { ...s.terms, balance_cents: 1 } },
      { ...s, terms: { ...s.terms, status: "draft" } },
      { ...s, booking: { ...s.booking, policy: "on_payment" } },
      { ...s, booking: { ...s.booking, legacy_signed: "no" } },
    ]) expect(paymentSummarySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("parses the client summary with its frozen discount breakdown, and refuses a breakdown that doesn't add up", () => {
    expect(clientPaymentSummarySchema.parse(clientSummary()).pricing).toBeUndefined();
    expect(clientPaymentSummarySchema.parse({ ...clientSummary(), pricing }).pricing?.discount.amount_cents).toBe(23_500);
    const before = { ...clientSummary(), terms_status: null, total_cents: null, deposit_percent: null, deposit_cents: null, booking_status: null };
    expect(clientPaymentSummarySchema.safeParse(before).success).toBe(true);
    expect(clientPaymentSummarySchema.safeParse({ ...clientSummary(), pricing: { ...pricing, total_cents: 243_174 } }).success).toBe(false);
    expect(clientPaymentSummarySchema.safeParse({ ...clientSummary(), pricing: { ...pricing, discounted_subtotal_cents: 211_501 } }).success).toBe(false);
    expect(clientPaymentSummarySchema.safeParse({ ...clientSummary(), booking_status: "awaiting_signature" }).success).toBe(false);
  });

  it("reads a summary as null when there is none or it fails validation, never as substitute figures", () => {
    expect(readPaymentSummary(null, "event_payment_summary")).toBeNull();
    expect(readPaymentSummary(staffSummary(), "event_payment_summary")?.received_cents).toBe(100_000);
    const lines = logged(() => expect(readPaymentSummary({ ...clientSummary(), received_cents: -1 }, "client_payment_summary")).toBeNull());
    expect(JSON.parse(lines[0])).toMatchObject({ category: "data", operation: "client_payment_summary" });
  });

  it("shows no discount breakdown, rather than a partial one, when a tax line is malformed", () => {
    const partial = { ...pricing, tax_breakdown: [pricing.tax_breakdown[0], { label: "QST", rate_ppm: "99750", amount_cents: 21_098 }] };
    logged(() => expect(discountBreakdown(partial)).toBeNull());
    expect(discountBreakdown(pricing)?.taxes).toHaveLength(2);
    // A contract without a discount has no breakdown, and nothing is logged.
    expect(logged(() => expect(discountBreakdown({ subtotal_cents: 1, tax_breakdown: [], total_cents: 1 })).toBeNull())).toEqual([]);
  });
});

describe("stored priced selections", () => {
  const offer = demoOffer();
  const priced = () => {
    const result = priceSelection(offer, { package_key: "signature", answers: baseAnswers, addons: { uplights_4: 2 } });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return JSON.parse(JSON.stringify(result.selection));
  };

  it("parses what pricing produces, as stored, and records from before discounts existed", () => {
    expect(pricedSelectionSchema.parse(priced())).toEqual(priced());
    const discounted = priceSelection({ ...offer, discount: { type: "fixed", amount_cents: 10_000, label: "Courtesy" } }, { package_key: "essential", answers: baseAnswers });
    if (!discounted.ok) throw new Error("not priced");
    expect(pricedSelectionSchema.parse(JSON.parse(JSON.stringify(discounted.selection))).discount_cents).toBe(10_000);
    // Stored records carry the offer hash; read-only displays need it to match the offer.
    expect(selectionRecordSchema.parse(toSelectionRecord(priced(), HASH)).offer_sha256).toBe(HASH);
    expect(selectionRecordSchema.safeParse(priced()).success).toBe(false);
  });

  it("refuses a record whose figures don't follow from its lines", () => {
    const tamper = (change: (s: ReturnType<typeof priced>) => void) => {
      const s = priced();
      change(s);
      return pricedSelectionSchema.safeParse(s).success;
    };
    expect(tamper(() => {})).toBe(true);
    expect(tamper((s) => (s.lines[0].line_total_cents += 1))).toBe(false);
    expect(tamper((s) => (s.subtotal_cents += 1))).toBe(false);
    expect(tamper((s) => (s.total_cents -= 1))).toBe(false);
    expect(tamper((s) => (s.tax_cents += 1))).toBe(false);
    expect(tamper((s) => (s.lines[0].unit_price_cents = -1))).toBe(false);
    expect(tamper((s) => (s.lines = s.lines.filter((l: { source: string }) => l.source !== "package")))).toBe(false);
    expect(tamper((s) => (s.pricing_version = "flux-pricing-2"))).toBe(false);
    expect(tamper((s) => (s.discount_cents = 0))).toBe(false);
  });
});

describe("contract review and generation", () => {
  const review = {
    contract_id: ID, status: "draft", sent_at: null, eligible: true, problems: [], can_send: true, send_unavailable_reason: null,
    signer: { name: "Robin", email: "robin@example.test" }, business: { name: "IT Sound", legal_name: null },
    deposit_percent: 50, deposit_cents: 50, balance_cents: 50, total_cents: 100, currency: "CAD", balance_due_date: null, content_sha256: HASH,
  };

  it("parses a review and refuses one whose eligibility or terms don't agree", () => {
    expect(contractReviewSchema.parse(review).eligible).toBe(true);
    expect(contractReviewSchema.safeParse({ ...review, eligible: true, problems: [{ code: "signer", message: "No signer" }] }).success).toBe(false);
    expect(contractReviewSchema.safeParse({ ...review, balance_cents: 49 }).success).toBe(false);
  });

  it("parses every generation outcome and refuses a created draft without its id", () => {
    expect(generateContractResultSchema.parse({ status: "created", contract_id: ID, content_sha256: HASH, replaced_id: null })).toEqual({ status: "created", contract_id: ID });
    expect(generateContractResultSchema.parse({ status: "incomplete", missing: [{ key: "signer", label: "Signer", hint: "Mark a signer." }] }).status).toBe("incomplete");
    expect(generateContractResultSchema.parse({ status: "conflict", contract_id: null }).status).toBe("conflict");
    expect(generateContractResultSchema.safeParse({ status: "created" }).success).toBe(false);
    expect(generateContractResultSchema.safeParse({ status: "drafted", contract_id: ID }).success).toBe(false);
  });
});
