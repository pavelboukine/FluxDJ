import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientPayments } from "@/components/payments/client-payments";
import { hubNextStep, type HubFacts } from "@/lib/client-event";
import type { HomeEvent } from "@/lib/client-home";
import { clientContractViewSchema, contractReviewSchema, contractTerms } from "@/lib/contracts/responses";
import { renderBookingConfirmedEmail, renderContractEmail } from "@/lib/email/templates";
import { paymentOverview } from "@/lib/events/workspace";
import { clientPaymentSummarySchema, depositPercentSuffix, paymentSummarySchema, type ClientPaymentSummary } from "@/lib/payments";

/**
 * The three shapes of contract, as the app reads them: proposal-backed (every
 * contract today), direct with stated terms, direct with none. Null is never
 * zero, and a genuine zero stays a zero.
 */
const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const stated = { total_cents: 100_000, deposit_percent: 50, deposit_cents: 50_000, balance_cents: 50_000, balance_due_date: null };
const none = { total_cents: null, deposit_percent: null, deposit_cents: null, balance_cents: null, balance_due_date: null };

const view = (money: object, extra: object = {}) => ({
  state: "available",
  brand: { display_name: "DJ", brand_colors: {} },
  contract: {
    id, status: "sent", sent_at: "2027-01-01T00:00:00+00:00", content_sha256: sha, rendered_content: {}, signer_name: "Riya", currency: "CAD",
    signing_mode: "demo", event_title: "Event", event_date: "2027-06-12", legal_name: "DJ Inc.", ...money, ...extra,
  },
  signing: { signed: false, enabled: true, consent_version: "demo-v1", consent_text: "I agree." },
});
const parseView = (v: unknown) => clientContractViewSchema.safeParse(v);

describe("the client's contract view", () => {
  it("reads a proposal-backed contract as before", () => {
    const parsed = parseView(view(stated));
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.state !== "available") throw new Error("expected a contract");
    expect(contractTerms(parsed.data.contract)).toEqual({
      financialTerms: "stated", currency: "CAD", direct: false, totalCents: 100_000, depositPercent: 50, depositCents: 50_000, balanceCents: 50_000, balanceDueDate: null,
    });
  });

  it("reads a direct contract without financial terms as having none, not as zero", () => {
    const parsed = parseView(view(none, { source: "direct" }));
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.state !== "available") throw new Error("expected a contract");
    expect(contractTerms(parsed.data.contract)).toEqual({ financialTerms: "none", currency: "CAD" });
  });

  it("keeps a genuine zero-dollar contract a real zero", () => {
    const parsed = parseView(view({ ...stated, total_cents: 0, deposit_cents: 0, balance_cents: 0 }));
    if (!parsed.success || parsed.data.state !== "available") throw new Error("expected a contract");
    expect(contractTerms(parsed.data.contract)).toMatchObject({ financialTerms: "stated", totalCents: 0 });
  });

  it("accepts a direct contract that states an amount instead of a percentage, but only a direct one", () => {
    expect(parseView(view({ ...stated, deposit_percent: null }, { source: "direct" })).success).toBe(true);
    expect(parseView(view({ ...stated, deposit_percent: null })).success).toBe(false);
  });

  it("refuses a proposal-backed contract with no money: missing terms never pass as direct by accident", () => {
    expect(parseView(view(none)).success).toBe(false);
  });

  it.each([
    ["a total without a deposit", { ...none, total_cents: 100 }],
    ["a deposit without a total", { ...none, deposit_cents: 100 }],
    ["a balance without a total", { ...none, balance_cents: 100 }],
    ["a percentage with no terms", { ...none, deposit_percent: 50 }],
    ["amounts that don't add up", { ...stated, deposit_cents: 1 }],
  ])("refuses %s", (_, money) => {
    expect(parseView(view(money, { source: "direct" })).success).toBe(false);
  });
});

describe("the send review", () => {
  const review = (money: object, extra: object = {}) => ({
    contract_id: id, status: "draft", sent_at: null, eligible: true, problems: [], can_send: true, send_unavailable_reason: null,
    signer: { name: "Riya", email: "r@example.test" }, business: {}, currency: "CAD", content_sha256: sha, ...money, ...extra,
  });
  it("reads all three shapes and refuses a proposal-backed one with no money", () => {
    expect(contractReviewSchema.safeParse(review(stated)).success).toBe(true);
    expect(contractReviewSchema.safeParse(review(none, { source: "direct" })).success).toBe(true);
    expect(contractReviewSchema.safeParse(review(none)).success).toBe(false);
  });
});

describe("payment summaries", () => {
  const booking = { lifecycle_status: "booked", booking_confirmed_at: "2027-01-01T00:00:00+00:00", policy: "on_signature", legacy_signed: false, deposit_no_longer_met: false };
  const noTerms = {
    currency: "CAD", terms: null, no_financial_terms: true, received_cents: 0, valid_payments: 0, other_currency_payments: 0,
    deposit_outstanding_cents: null, remaining_balance_cents: null, credit_cents: null, invoice_url: null, booking,
  };

  it("shows no figures, and so never 'Paid in full', without financial terms", () => {
    const s = paymentSummarySchema.parse(noTerms);
    expect(s.no_financial_terms).toBe(true);
    expect(paymentOverview(s)).toEqual({ figures: null, next: null });
  });

  it("still says 'Paid in full' for a genuine zero-dollar contract", () => {
    const s = paymentSummarySchema.parse({
      ...noTerms, no_financial_terms: undefined,
      terms: { status: "signed", contract_id: id, total_cents: 0, deposit_percent: null, deposit_cents: 0, balance_cents: 0, balance_due_date: null },
      deposit_outstanding_cents: 0, remaining_balance_cents: 0, credit_cents: 0,
    });
    expect(paymentOverview(s)?.figures).toContainEqual({ label: "Balance", value: "Paid in full" });
  });

  it("reads the client's summary without financial terms", () => {
    const s = clientPaymentSummarySchema.parse({
      currency: "CAD", terms_status: null, no_financial_terms: true, total_cents: null, deposit_percent: null, deposit_cents: null, balance_due_date: null,
      received_cents: 0, deposit_outstanding_cents: null, remaining_balance_cents: null, credit_cents: null, invoice_url: null, booking_status: "booked",
    });
    expect(s.remaining_balance_cents).toBeNull();
  });

  it("labels a deposit with its percentage only when there is one", () => {
    expect(depositPercentSuffix(50)).toBe(" (50%)");
    expect(depositPercentSuffix(0)).toBe(" (0%)");
    expect(depositPercentSuffix(null)).toBe("");
  });
});

describe("the client's payments section", () => {
  const summary = (over: Partial<ClientPaymentSummary>): ClientPaymentSummary => ({
    currency: "CAD", terms_status: null, no_financial_terms: true, total_cents: null, deposit_percent: null, deposit_cents: null, balance_due_date: null,
    received_cents: 0, deposit_outstanding_cents: null, remaining_balance_cents: null, credit_cents: null, invoice_url: null, booking_status: "booked", ...over,
  });
  const render = (payments: ClientPaymentSummary | null) =>
    renderToStaticMarkup(ClientPayments({ terms: { financialTerms: "none", currency: "CAD" }, signed: true, payments, djName: "DJ" }));

  it("renders nothing when there are no terms and nothing was recorded", () => {
    expect(render(summary({}))).toBe("");
    expect(render(null)).toBe("");
  });

  it("shows only what was actually recorded, and no invented figures", () => {
    const html = render(summary({ received_cents: 5_000 }));
    expect(html).toContain("50.00");
    expect(html).not.toMatch(/Total|Deposit|Balance|Paid in full|No payment due/);
  });

  it("is unchanged for a contract with terms", () => {
    const html = renderToStaticMarkup(
      ClientPayments({
        terms: { financialTerms: "stated", currency: "CAD", direct: false, totalCents: 100_000, depositPercent: 50, depositCents: 50_000, balanceCents: 50_000, balanceDueDate: null },
        signed: true, payments: null, djName: "DJ",
      }),
    );
    expect(html).toContain("Total, including taxes");
    expect(html).toContain("Deposit on signing (50%)");
  });

  it("says 'Total' for a direct contract, which states no taxes, and leaves out a percentage it doesn't have", () => {
    const html = renderToStaticMarkup(
      ClientPayments({
        terms: { financialTerms: "stated", currency: "CAD", direct: true, totalCents: 100_000, depositPercent: null, depositCents: 20_000, balanceCents: 80_000, balanceDueDate: null },
        signed: false, payments: null, djName: "DJ",
      }),
    );
    expect(html).toContain("Total");
    expect(html).not.toContain("including taxes");
    expect(html).toContain("Deposit on signing<");
    expect(html).not.toContain("null");
  });
});

describe("the client's event hub", () => {
  const home = { eventId: id, tenantSlug: "dj", tenantName: "DJ", title: "Event", eventDate: "2027-06-12", timezone: "America/Toronto", venueName: null, lifecycle: "awaiting_signature", bookingSource: "flux", contract: null, payments: null, plan: null } as HomeEvent;
  const step = (totalCents: number | null) => hubNextStep({ home, contract: { id, status: "sent", totalCents, signable: true }, plan: null } satisfies HubFacts);

  it("doesn't promise payment terms a contract doesn't have", () => {
    expect(step(null).text).toBe("Read the agreement from DJ, then sign online.");
  });
  it("is unchanged for a priced contract", () => {
    expect(step(100).text).toBe("Read the agreement and payment terms from DJ, then sign online.");
    expect(step(0).text).toBe("Read the agreement and payment terms from DJ, then sign online.");
  });
});

describe("emails", () => {
  const common = { canReply: true, tenantDisplayName: "DJ", legalName: "DJ Inc.", contactEmail: "hi@example.test", clientName: "Riya", eventTitle: "Event" } as const;
  const contractEmail = (depositCents: number | null, depositPercent: number | null) =>
    renderContractEmail({ ...common, eventDate: "2027-06-12", depositCents, depositPercent, currency: "CAD", invitationLink: "https://example.test/x" });
  const booking = (over: { totalCents: number | null; depositCents?: number; remainingCents?: number; receivedCents?: number }) =>
    renderBookingConfirmedEmail({ ...common, eventDate: "2027-06-12", currency: "CAD", depositCents: 0, receivedCents: 0, remainingCents: 0, creditCents: 0, balanceDueDate: null, bookedOn: "2027-01-20", eventLink: "https://example.test/e", ...over });

  it("the contract email mentions no deposit without financial terms", () => {
    const { text, html } = contractEmail(null, null);
    for (const body of [text, html]) expect(body).not.toMatch(/Deposit|0\.00|% of the total/);
    expect(text).toContain("Read your contract");
  });
  it("the contract email states a fixed deposit with no percentage", () => {
    const { text } = contractEmail(20_000, null);
    expect(text).toContain("200.00");
    expect(text).not.toMatch(/% of the total|null/);
  });
  it("the contract email is unchanged for a proposal-backed contract", () => {
    expect(contractEmail(123_700, 30).text).toContain("(30% of the total)");
  });

  it("the booking email claims nothing about money without financial terms", () => {
    const { text, html } = booking({ totalCents: null });
    for (const body of [text, html]) {
      expect(body).not.toMatch(/Nothing remains|Paid in full|Still to pay|Total|Received as of|0\.00|payments/i);
    }
    expect(text).toContain("has confirmed your booking");
    expect(text).toContain("View your event");
  });
  it("the booking email still tells a genuine zero-dollar client nothing is owed", () => {
    expect(booking({ totalCents: 0 }).text).toContain("Nothing remains to be paid.");
  });
  it("the booking email is unchanged for a priced contract", () => {
    const { text } = booking({ totalCents: 100_000, depositCents: 50_000, receivedCents: 50_000, remainingCents: 50_000 });
    expect(text).toContain("Still to pay:");
    expect(text).toContain("Your event page has your booking, contract and payments in one place.");
  });
});
