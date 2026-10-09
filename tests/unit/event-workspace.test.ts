import { describe, expect, it } from "vitest";
import { contractSummary, nextAction, paymentOverview, planningLine, proposalSummary, type ContractRecord, type WorkspaceFacts } from "@/lib/events/workspace";
import type { PaymentSummary } from "@/lib/payments";

const NOW = new Date("2026-10-07T16:00:00Z");

function facts(over: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return {
    slug: "dj",
    eventId: "ev",
    now: NOW,
    archived: false,
    lifecycle: "lead",
    proposals: [],
    activeProposalId: null,
    approvalId: null,
    contracts: [],
    payments: null,
    planning: { exists: false, progress: null, editing: null },
    primaryContact: { name: "Noam", archived: false },
    identitySaved: true,
    usableContractVersions: 1,
    ...over,
  };
}

const contract = (id: string, status: string, extra: Partial<ContractRecord> = {}): ContractRecord => ({
  id, status, signing_mode: "client_use", created_at: "2026-10-05T03:50:00Z", signed_at: status === "signed" ? "2026-10-05T03:52:00Z" : null, label: `Agreement ${id}`, ...extra,
});

function summary(over: Omit<Partial<PaymentSummary>, "booking"> & { booking?: Partial<PaymentSummary["booking"]> } = {}): PaymentSummary {
  const { booking, ...rest } = over;
  return {
    currency: "CAD",
    terms: { status: "signed", contract_id: "c1", total_cents: 324_229, deposit_percent: 50, deposit_cents: 162_115, balance_cents: 162_114, balance_due_date: null },
    received_cents: 0,
    valid_payments: 0,
    other_currency_payments: 0,
    deposit_outstanding_cents: 162_115,
    remaining_balance_cents: 324_229,
    credit_cents: 0,
    invoice_url: null,
    ...rest,
    booking: { lifecycle_status: "awaiting_deposit", booking_confirmed_at: null, policy: "on_deposit", legacy_signed: false, deposit_no_longer_met: false, ...booking },
  };
}

const progress = { scope: "available_sections_only", items: [], requirements_total: 49, requirements_met: 4, percent: 8, available_sections: 12, complete_sections: 0, unavailable_sections: 0 } as unknown as NonNullable<WorkspaceFacts["planning"]["progress"]>;
const editing = (state: "open" | "reopened" | "closed") =>
  ({ state, deadline: "2026-10-16T04:00:00Z", closes_at: state === "closed" ? null : state === "reopened" ? "2026-10-20T04:00:00Z" : "2026-10-16T04:00:00Z", timezone: "America/Toronto" }) as unknown as NonNullable<WorkspaceFacts["planning"]["editing"]>;

const pick = (f: WorkspaceFacts) => {
  const a = nextAction(f);
  return { key: a.key, primary: a.primary?.href ?? null, secondary: a.secondary?.href ?? null, waiting: a.waiting };
};

describe("next action", () => {
  it("a new event: create a proposal; a missing primary contact is named, not hidden", () => {
    expect(pick(facts())).toEqual({ key: "create_proposal", primary: "#proposal", secondary: null, waiting: false });
    expect(nextAction(facts({ primaryContact: null })).blockers.map((b) => b.link.href)).toEqual(["#contacts"]);
  });

  it("a draft: continue it", () => {
    const f = facts({ proposals: [{ id: "p1", revision: 1, status: "draft", expires_at: null }] });
    expect(pick(f)).toEqual({ key: "continue_proposal", primary: "/staff/dj/proposals/p1", secondary: null, waiting: false });
  });

  it("a sent proposal: waiting on the client, with a view link only", () => {
    const f = facts({ lifecycle: "lead", proposals: [{ id: "p1", revision: 1, status: "sent", expires_at: "2026-10-20T00:00:00Z" }], activeProposalId: "p1" });
    expect(pick(f)).toEqual({ key: "awaiting_selection", primary: null, secondary: "/staff/dj/proposals/p1", waiting: true });
  });

  it("an expired or declined offer: start a revised one", () => {
    const expired = facts({ proposals: [{ id: "p1", revision: 1, status: "sent", expires_at: "2026-10-01T00:00:00Z" }], activeProposalId: "p1" });
    expect(pick(expired).key).toBe("revise_offer");
    const declined = facts({ proposals: [{ id: "p1", revision: 1, status: "declined", expires_at: null }], activeProposalId: "p1" });
    expect(pick(declined)).toMatchObject({ key: "revise_offer", primary: "#proposal" });
  });

  it("a submitted proposal: review it, even while a revised draft is open", () => {
    const f = facts({
      lifecycle: "pending_approval",
      proposals: [{ id: "p1", revision: 1, status: "submitted", expires_at: null }, { id: "p2", revision: 2, status: "draft", expires_at: null }],
      activeProposalId: "p1",
    });
    expect(pick(f)).toEqual({ key: "review_submission", primary: "/staff/dj/proposals/p1", secondary: null, waiting: false });
  });

  it("an approved proposal without a current contract: prepare one, unless something blocks it", () => {
    const approved = { lifecycle: "awaiting_signature", proposals: [{ id: "p1", revision: 1, status: "approved", expires_at: null }], activeProposalId: "p1", approvalId: "a1" };
    expect(pick(facts(approved))).toMatchObject({ key: "prepare_contract", primary: "#contract" });
    // Replaced and void contracts aren't current.
    expect(pick(facts({ ...approved, contracts: [contract("c0", "void"), contract("c00", "replaced")] })).key).toBe("prepare_contract");
    const blocked = nextAction(facts({ ...approved, identitySaved: false, usableContractVersions: 0 }));
    expect(blocked.primary).toBeNull();
    expect(blocked.blockers.map((b) => b.link.href)).toEqual(["/staff/dj/settings", "/staff/dj/contract-templates"]);
  });

  it("a contract draft: review it; one that can't be signed online: regenerate", () => {
    const base = { lifecycle: "awaiting_signature", approvalId: "a1", proposals: [{ id: "p1", revision: 1, status: "approved", expires_at: null }], activeProposalId: "p1" };
    expect(pick(facts({ ...base, contracts: [contract("c1", "draft")] }))).toMatchObject({ key: "review_contract", primary: "/staff/dj/contracts/c1" });
    expect(pick(facts({ ...base, contracts: [contract("c1", "draft", { signing_mode: "none" })] }))).toMatchObject({ key: "regenerate_contract", primary: "#contract" });
  });

  it("a sent contract: waiting for the signature, with the contract page for resend, void and documents", () => {
    const f = facts({ lifecycle: "awaiting_signature", approvalId: "a1", contracts: [contract("c1", "sent")], payments: summary({ booking: { lifecycle_status: "awaiting_signature", policy: null } }) });
    expect(pick(f)).toEqual({ key: "awaiting_signature", primary: null, secondary: "/staff/dj/contracts/c1", waiting: true });
  });

  it("signed and awaiting the deposit: record a payment, with the outstanding amount from the summary", () => {
    const f = facts({ lifecycle: "awaiting_deposit", contracts: [contract("c1", "signed")], payments: summary({ deposit_outstanding_cents: 62_115 }) });
    const a = nextAction(f);
    expect(a).toMatchObject({ key: "record_payment", primary: { href: "#record-payment" } });
    expect(a.detail).toContain("$621.15 is still due toward the deposit");
  });

  it("a legacy signed contract: check booking (never inferred from the label alone)", () => {
    const f = facts({ lifecycle: "awaiting_signature", contracts: [contract("c1", "signed")], payments: summary({ booking: { lifecycle_status: "awaiting_signature", policy: null, legacy_signed: true } }) });
    expect(pick(f)).toMatchObject({ key: "check_booking", primary: "#payments" });
    // The same label without a signed contract is just waiting.
    expect(pick(facts({ lifecycle: "awaiting_signature", contracts: [contract("c1", "sent")] })).key).toBe("awaiting_signature");
  });

  it("booked: review planning (with the run sheet), or set it up; a lost deposit keeps the booking with a warning", () => {
    const booked = { lifecycle: "booked", contracts: [contract("c1", "signed")], payments: summary({ booking: { lifecycle_status: "booked", booking_confirmed_at: "2026-10-05T03:53:00Z" } }) };
    expect(pick(facts({ ...booked, planning: { exists: true, progress, editing: editing("open") } }))).toEqual({
      key: "review_planning", primary: "/staff/dj/events/ev/planning", secondary: "/staff/dj/events/ev/run-sheet", waiting: false,
    });
    expect(pick(facts(booked))).toMatchObject({ key: "set_up_planning", primary: "/staff/dj/events/ev/planning", secondary: null });
    const corrected = nextAction(facts({ ...booked, payments: summary({ deposit_outstanding_cents: 10_000, booking: { lifecycle_status: "booked", deposit_no_longer_met: true } }) }));
    expect(corrected.key).toBe("set_up_planning");
    expect(corrected.warning).toContain("The booking stands, but valid payments no longer cover the deposit ($100.00 short)");
  });

  it("archived, cancelled and completed events suggest no blocked action", () => {
    const archived = nextAction(facts({ archived: true, proposals: [{ id: "p1", revision: 1, status: "submitted", expires_at: null }], activeProposalId: "p1" }));
    expect(archived).toMatchObject({ key: "archived", primary: null, secondary: { href: "#manage" } });
    expect(nextAction(facts({ lifecycle: "completed", planning: { exists: true, progress, editing: null } }))).toMatchObject({ key: "completed", primary: null, secondary: { label: "Open run sheet" } });
  });
});

describe("summaries", () => {
  it("proposal: the draft first, and what the sent revision is doing", () => {
    const f = facts({ proposals: [{ id: "p1", revision: 1, status: "sent", expires_at: "2026-10-20T00:00:00Z" }, { id: "p2", revision: 2, status: "draft", expires_at: null }], activeProposalId: "p1" });
    expect(proposalSummary(f)).toMatchObject({ status: "Draft, not sent", detail: "Revision 2 · Revision 1: sent, waiting for the client", link: { href: "/staff/dj/proposals/p2" } });
    expect(proposalSummary(facts())).toMatchObject({ status: "No proposal yet", link: { href: "#proposal" } });
  });

  it("contract: the current one, never a replaced or void one", () => {
    const fmt = () => "Oct 5, 2026";
    expect(contractSummary(facts({ contracts: [contract("c2", "signed"), contract("c1", "void")] }), fmt)).toMatchObject({ status: "Signed Oct 5, 2026", link: { href: "/staff/dj/contracts/c2" } });
    expect(contractSummary(facts({ contracts: [contract("c1", "replaced")], approvalId: "a1" }), fmt)).toMatchObject({ status: "Ready to prepare" });
  });

  it("payments: figures straight from the summary, labelled by their terms", () => {
    const signed = paymentOverview(summary({ received_cents: 100_000, deposit_outstanding_cents: 62_115, remaining_balance_cents: 224_229 }))!;
    expect(signed.basis).toBe("Signed contract terms");
    expect(signed.rows).toEqual([
      { label: "Total", value: "$3,242.29" },
      { label: "Received", value: "$1,000.00" },
      { label: "Deposit", value: "$1,621.15" },
      { label: "Deposit due", value: "$621.15" },
      { label: "Balance", value: "$2,242.29" },
    ]);
    const sent = paymentOverview(summary({ terms: { ...summary().terms!, status: "sent" }, booking: { lifecycle_status: "awaiting_signature", policy: null } }))!;
    expect(sent.basis).toBe("Sent contract terms (not signed yet)");
    expect(sent.booking).toBe("Not booked");
  });

  it("payments: overpayment is a credit, no terms means only what was received", () => {
    const over = paymentOverview(summary({ received_cents: 400_000, deposit_outstanding_cents: 0, remaining_balance_cents: 0, credit_cents: 75_771, booking: { lifecycle_status: "booked" } }))!;
    expect(over.rows).toContainEqual({ label: "Balance", value: "Paid in full" });
    expect(over.rows).toContainEqual({ label: "Credit", value: "$757.71" });
    expect(over.rows).toContainEqual({ label: "Deposit due", value: "Received" });
    expect(over.booking).toBe("Booking confirmed");
    const none = paymentOverview(summary({ terms: null, received_cents: 25_000, deposit_outstanding_cents: null, remaining_balance_cents: null, credit_cents: null, booking: { lifecycle_status: "lead", policy: null } }))!;
    expect(none.rows).toEqual([{ label: "Received", value: "$250.00" }]);
    expect(none.basis).toBe("No contract terms yet");
  });

  it("payments: a corrected deposit after booking keeps the booking and says so", () => {
    const o = paymentOverview(summary({ deposit_outstanding_cents: 10_000, booking: { lifecycle_status: "booked", deposit_no_longer_met: true } }))!;
    expect(o.booking).toBe("Booking confirmed");
    expect(o.warning).toBe("Valid payments no longer cover the deposit; the booking stands.");
  });

  it("planning: open, reopened and read-only, in the event's time zone", () => {
    expect(planningLine({ exists: true, progress, editing: editing("open") })).toBe("Client editing open until Oct 16, 2026, 12:00 a.m. EDT (America/Toronto).");
    expect(planningLine({ exists: true, progress, editing: editing("reopened") })).toBe("Client editing reopened until Oct 20, 2026, 12:00 a.m. EDT (America/Toronto).");
    expect(planningLine({ exists: true, progress, editing: editing("closed") })).toContain("read-only since Oct 16, 2026");
    expect(planningLine({ exists: true, progress, editing: { ...editing("closed"), closed_at: "2026-10-02T15:00:00+00:00" } }))
      .toBe("Client editing closed by staff since Oct 2, 2026, 11:00 a.m. EDT (America/Toronto). Staff can still edit.");
    expect(planningLine({ exists: false, progress: null, editing: null })).toBeNull();
  });
});
