import { describe, expect, it } from "vitest";
import { describeDbError } from "@/lib/db-errors";
import { NO_PRICING_OUTLINE, STATED_PRICE_OUTLINE } from "@/lib/contracts/demo-template";
import { PLACEHOLDER_RE, groupFields, usesPaymentFields, usesProposalFields } from "@/lib/contracts/fields";
import { renderContractEmail } from "@/lib/email/templates";
import { bookingFlowSteps, bookingWorkflowFrom, primaryContactHelp, readBookingWorkflow } from "@/lib/events/booking-workflow";
import { eventDisplayStatus } from "@/lib/events/status";
import { nextAction, workspaceStage, type WorkspaceFacts } from "@/lib/events/workspace";

const facts = (over: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  slug: "biz",
  eventId: "e1",
  now: new Date("2027-01-01T12:00:00Z"),
  archived: false,
  lifecycle: "lead",
  bookingSource: "flux",
  proposals: [],
  activeProposalId: null,
  approvalId: null,
  contracts: [],
  payments: null,
  planning: { exists: false, progress: null, editing: null },
  primaryContact: { name: "Riya", archived: false },
  identitySaved: true,
  usableContractVersions: 1,
  ...over,
});
const contract = (status: string) => ({ id: "c1", status, signing_mode: "client_use", created_at: "2027-01-01T00:00:00Z", signed_at: status === "signed" ? "2027-01-02T00:00:00Z" : null, label: "Agreement v1" });
const direct = (over: Partial<WorkspaceFacts> = {}) => facts({ contractFirst: true, ...over });

describe("booking workflow selection", () => {
  it("maps the two checkboxes to the three workflows", () => {
    expect(bookingWorkflowFrom(true, true)).toBe("full");
    expect(bookingWorkflowFrom(true, false)).toBe("contract_first");
    expect(bookingWorkflowFrom(false, false)).toBe("external");
  });

  it("maps each workflow to the approved columns", () => {
    expect(readBookingWorkflow(true, true)).toEqual({ ok: true, values: { booking_source: "flux", contract_first: false } });
    expect(readBookingWorkflow(true, false)).toEqual({ ok: true, values: { booking_source: "flux", contract_first: true } });
    expect(readBookingWorkflow(false, false)).toEqual({ ok: true, values: { booking_source: "external", contract_first: false } });
  });

  it("rejects a proposal with no contract, which the form can't send", () => {
    expect(readBookingWorkflow(false, true)).toMatchObject({ ok: false });
  });

  it("previews each workflow's steps, never promising a deposit", () => {
    expect(bookingFlowSteps("full")).toEqual(["Proposal", "Contract", "Confirmation", "Planning"]);
    expect(bookingFlowSteps("contract_first")).toEqual(["Contract", "Confirmation", "Planning"]);
    for (const w of ["full", "contract_first", "external"] as const) expect(bookingFlowSteps(w).join(" ")).not.toMatch(/deposit|payment/i);
  });

  it("says what the primary contact does on each workflow", () => {
    expect(primaryContactHelp("full")).toBe("This person will receive the proposal and sign the contract.");
    expect(primaryContactHelp("contract_first")).toBe("This person will receive and sign the contract.");
    expect(primaryContactHelp("external")).toBe("This person will receive access to plan the event with you.");
  });
});

describe("the workspace's next step", () => {
  it("leaves the full workflow as it was", () => {
    expect(nextAction(facts())).toMatchObject({ key: "create_proposal", primary: { label: "Create proposal" } });
    expect(nextAction(facts({ approvalId: "a1", lifecycle: "awaiting_signature" })).detail).toBe("The client's selection is approved. Choose a template version and generate the draft.");
  });

  it("prepares the contract on a contract-first event, never a proposal step", () => {
    const a = nextAction(direct());
    expect(a).toMatchObject({ key: "prepare_contract", primary: { label: "Prepare contract", href: "#contract" }, blockers: [] });
    expect(`${a.title} ${a.detail}`).not.toMatch(/create a proposal|approved|selection/i);
  });

  it("says what stops the contract: settings, templates and the signer", () => {
    const a = nextAction(direct({ identitySaved: false, usableContractVersions: 0, primaryContact: null }));
    expect(a.primary).toBeNull();
    expect(a.blockers.map((b) => b.link.label)).toEqual(["Contacts", "Business settings", "Contract templates"]);
  });

  it("follows the same contract steps once a contract exists", () => {
    expect(nextAction(direct({ lifecycle: "awaiting_signature", contracts: [contract("draft")] })).key).toBe("review_contract");
    expect(nextAction(direct({ lifecycle: "awaiting_signature", contracts: [contract("sent")] })).key).toBe("awaiting_signature");
    expect(nextAction(direct({ lifecycle: "awaiting_signature", contracts: [contract("void")] })).key).toBe("prepare_contract");
  });

  it("asks for the deposit when one is due, otherwise moves on to planning", () => {
    expect(nextAction(direct({ lifecycle: "awaiting_deposit", contracts: [contract("signed")] })).key).toBe("record_payment");
    expect(nextAction(direct({ lifecycle: "booked", contracts: [contract("signed")], planning: { exists: true, awaitingSetup: true, progress: null, editing: null } })).key).toBe("set_up_planning");
  });

  it("orders the page by the same stages", () => {
    expect(workspaceStage(direct()).stage).toBe("booking");
    expect(workspaceStage(direct({ lifecycle: "awaiting_deposit", contracts: [contract("signed")] })).stage).toBe("deposit");
    expect(workspaceStage(direct({ lifecycle: "booked", contracts: [contract("signed")] })).stage).toBe("booked");
  });

  it("leaves an event booked elsewhere on planning only", () => {
    expect(nextAction(facts({ bookingSource: "external" })).key).toBe("set_up_planning");
  });
});

describe("the event's status", () => {
  const records = { bookingSource: "flux", proposalDraft: false, contractStatus: null };
  it("doesn't call a contract-first event approved after its contract is voided", () => {
    expect(eventDisplayStatus({ ...records, lifecycle: "awaiting_signature", proposalStatus: null })).toBe("Contract to prepare");
    expect(eventDisplayStatus({ ...records, lifecycle: "awaiting_signature", proposalStatus: "approved" })).toBe("Approved · contract to prepare");
  });
});

describe("contract fields", () => {
  it("tells proposal fields and payment fields apart", () => {
    for (const k of ["package.name", "gear.extras", "pricing.taxes", "pricing.subtotal", "pricing.discount"]) expect(usesProposalFields([k]), k).toBe(true);
    for (const k of ["pricing.total", "pricing.currency", "payment.deposit", "client.name", "contract.services"]) expect(usesProposalFields([k]), k).toBe(false);
    for (const k of ["pricing.total", "payment.deposit", "payment.balance_due_date"]) expect(usesPaymentFields([k]), k).toBe(true);
    for (const k of ["client.name", "contract.services", "package.name"]) expect(usesPaymentFields([k]), k).toBe(false);
  });

  it("groups the services field on its own in the editor", () => {
    expect(groupFields([{ key: "contract.services", label: "Services", description: "" }])[0].label).toBe("Contract");
  });

  const keys = (o: typeof NO_PRICING_OUTLINE) => [o.title, ...o.sections.flatMap((s) => [s.heading, s.body])].flatMap((t) => [...t.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));

  it("gives a no-pricing outline no payment or proposal fields", () => {
    expect(usesPaymentFields(keys(NO_PRICING_OUTLINE))).toBe(false);
    expect(usesProposalFields(keys(NO_PRICING_OUTLINE))).toBe(false);
  });

  it("makes a stated-price outline state the total and deposit, with no proposal fields", () => {
    expect(keys(STATED_PRICE_OUTLINE)).toEqual(expect.arrayContaining(["pricing.total", "payment.deposit", "payment.balance", "payment.balance_due_date"]));
    expect(usesProposalFields(keys(STATED_PRICE_OUTLINE))).toBe(false);
  });

  it("keeps outlines out of client use until the business adds its own terms", () => {
    for (const o of [NO_PRICING_OUTLINE, STATED_PRICE_OUTLINE]) expect(o.sections.at(-1)!.body).toMatch(/Replace this text with your own/);
  });
});

describe("the contract email", () => {
  const input = { tenantDisplayName: "Biz", canReply: true, legalName: "Biz Inc.", contactEmail: "a@b.test", clientName: "Riya", eventTitle: "Party", currency: "CAD", invitationLink: "https://x.test/i", expiresAt: null };
  const send = (depositCents: number | null, depositPercent: number | null) => renderContractEmail({ ...input, depositCents, depositPercent } as Parameters<typeof renderContractEmail>[0]).text;

  it("states a real deposit", () => {
    expect(send(50_000, 50)).toMatch(/Deposit due on signing[\s\S]*500\.00[\s\S]*50% of the total/);
    expect(send(50_000, null)).toMatch(/Deposit due on signing[\s\S]*500\.00/);
    expect(send(50_000, null)).not.toContain("% of the total");
  });

  it("says nothing about a deposit a direct contract doesn't have", () => {
    expect(send(0, null)).not.toContain("Deposit");
    expect(send(null, null)).not.toContain("Deposit");
  });
});

describe("database errors", () => {
  it("explains why an event with no proposal can't start one", () => {
    expect(describeDbError({ code: "22023", message: "contract_first: this event goes straight to a contract, so it has no proposal" })).toBe("This event goes straight to a contract, so it has no proposal.");
  });
});
