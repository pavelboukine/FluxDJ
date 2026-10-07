import type { PaymentSummary } from "@/lib/payments";
import { formatCents } from "@/lib/money";
import { shortInstant } from "@/lib/dates";
import type { StaffEditing } from "@/lib/planning/cutoff";
import { progressHeadline, type PlanProgress } from "@/lib/planning/view";

/**
 * The staff event workspace: what to do next and one-line summaries, decided
 * from the event's actual records (proposals, approval, contracts, the
 * database's payment summary and planning view), never from the lifecycle
 * label alone. Every action is a link to the existing screen or section
 * where the database still checks eligibility and asks for confirmation;
 * nothing here performs an action.
 */

export type ProposalRecord = { id: string; revision: number; status: string; expires_at: string | null };
export type ContractRecord = { id: string; status: string; signing_mode: string; created_at: string; signed_at: string | null; label: string };

export type WorkspaceFacts = {
  slug: string;
  eventId: string;
  now: Date;
  archived: boolean;
  lifecycle: string;
  proposals: ProposalRecord[];
  activeProposalId: string | null;
  /** The active proposal is approved and its approval is current (contracts are generated from it). */
  approvalId: string | null;
  contracts: ContractRecord[];
  /** private.event_payment_summary, or null if it could not be read. */
  payments: PaymentSummary | null;
  planning: { exists: boolean; progress: PlanProgress | null; editing: StaffEditing | null };
  primaryContact: { name: string; archived: boolean } | null;
  /** Legal name, address and contact email saved (contracts need them). */
  identitySaved: boolean;
  /** Published template versions a contract can be generated from (client use or DEMO). */
  usableContractVersions: number;
};

export type Link = { label: string; href: string };
export type Blocker = { text: string; link: Link };

export type NextAction = {
  key: string;
  title: string;
  detail: string;
  /** The recommended step; absent when staff are waiting or a blocker must be resolved first. */
  primary: Link | null;
  secondary: Link | null;
  /** Waiting on the client: nothing for staff to do except look. */
  waiting: boolean;
  blockers: Blocker[];
  /** Something staff should know even while the next step is elsewhere (never colour alone). */
  warning: string | null;
};

const currentContracts = (contracts: ContractRecord[]) => ({
  signed: contracts.find((c) => c.status === "signed") ?? null,
  sent: contracts.find((c) => c.status === "sent") ?? null,
  draft: contracts.find((c) => c.status === "draft") ?? null,
});

/** The proposal staff work with now: the editable draft, else the event's active (sent) proposal. */
export function currentProposals<P extends ProposalRecord>(f: { proposals: P[]; activeProposalId: string | null }) {
  const draft = f.proposals.find((p) => p.status === "draft") ?? null;
  const active = f.proposals.find((p) => p.id === f.activeProposalId) ?? null;
  return { draft, active };
}

const isExpired = (p: ProposalRecord, now: Date) => p.status === "expired" || (p.status === "sent" && p.expires_at !== null && new Date(p.expires_at) <= now);

export function nextAction(f: WorkspaceFacts): NextAction {
  const base = `/staff/${f.slug}`;
  const event = `${base}/events/${f.eventId}`;
  const planningHref = `${event}/planning`;
  const runSheet: Link = { label: "Open run sheet", href: `${event}/run-sheet` };
  const blank: Pick<NextAction, "secondary" | "waiting" | "blockers" | "warning"> = { secondary: null, waiting: false, blockers: [], warning: null };
  const { signed, sent, draft: contractDraft } = currentContracts(f.contracts);
  const { draft, active } = currentProposals(f);
  const booking = f.payments?.booking ?? null;
  const money = (cents: number) => formatCents(cents, f.payments?.currency ?? "CAD");

  if (f.archived) {
    return {
      ...blank,
      key: "archived",
      title: "Paused until you unarchive it",
      detail: "Client links are revoked, and proposals, contracts and payments are paused. Its history stays available below.",
      primary: null,
      secondary: { label: "Unarchive", href: "#manage" },
    };
  }
  if (f.lifecycle === "cancelled" || f.lifecycle === "completed") {
    return {
      ...blank,
      key: f.lifecycle,
      title: f.lifecycle === "completed" ? "This event is completed" : "This event is cancelled",
      detail: "Nothing else is needed here. Its history stays available below.",
      primary: null,
      secondary: f.planning.exists ? runSheet : null,
    };
  }

  if (signed) {
    if (f.lifecycle === "booked") {
      const warning = booking?.deposit_no_longer_met
        ? `The booking stands, but valid payments no longer cover the deposit${f.payments?.deposit_outstanding_cents ? ` (${money(f.payments.deposit_outstanding_cents)} short)` : ""}. Check the payments.`
        : null;
      return f.planning.exists
        ? { ...blank, key: "review_planning", title: "Review planning", detail: planningLine(f.planning) ?? "The event is booked.", primary: { label: "Review planning", href: planningHref }, secondary: runSheet, warning }
        : { ...blank, key: "set_up_planning", title: "Set up planning", detail: "The event is booked but has no plan yet. You choose a template when you set it up.", primary: { label: "Set up planning", href: planningHref }, warning };
    }
    if (f.lifecycle === "awaiting_deposit") {
      const owed = f.payments?.deposit_outstanding_cents;
      return {
        ...blank,
        key: "record_payment",
        title: "Record the deposit",
        detail: `The contract is signed. ${owed ? `${money(owed)} is still due toward the deposit` : "The deposit is still due"}; the booking is confirmed once it's recorded.`,
        primary: { label: "Record payment", href: "#record-payment" },
      };
    }
    if (booking?.legacy_signed) {
      return {
        ...blank,
        key: "check_booking",
        title: "Check booking",
        detail: "The contract was signed before booking rules existed, so it isn't confirmed automatically.",
        primary: { label: "Check booking", href: "#payments" },
      };
    }
    return { ...blank, key: "review_payments", title: "Review payments", detail: "The contract is signed.", primary: { label: "Review payments", href: "#payments" } };
  }

  if (sent) {
    return {
      ...blank,
      key: "awaiting_signature",
      title: "Waiting for the client to sign",
      detail: "The contract was sent. Resending, voiding and its document are on the contract page.",
      primary: null,
      secondary: { label: "View contract", href: `${base}/contracts/${sent.id}` },
      waiting: true,
    };
  }
  if (contractDraft) {
    return contractDraft.signing_mode === "none"
      ? {
          ...blank,
          key: "regenerate_contract",
          title: "Regenerate the contract",
          detail: "The current draft came from a template version that can't be signed online. Generate a new draft from a version published for client use.",
          primary: { label: "Prepare contract", href: "#contract" },
        }
      : { ...blank, key: "review_contract", title: "Review and send the contract", detail: "A contract draft is ready. Nothing has been sent to the client.", primary: { label: "Review contract", href: `${base}/contracts/${contractDraft.id}` } };
  }
  if (f.approvalId) {
    const blockers: Blocker[] = [];
    if (!f.identitySaved) blockers.push({ text: "Your legal name, address and contact email aren't saved yet.", link: { label: "Business settings", href: `${base}/settings` } });
    if (f.usableContractVersions === 0) blockers.push({ text: "No contract template version is published yet.", link: { label: "Contract templates", href: `${base}/contract-templates` } });
    return {
      ...blank,
      key: "prepare_contract",
      title: "Prepare the contract",
      detail: blockers.length > 0 ? "The client's selection is approved. Resolve these first:" : "The client's selection is approved. Choose a template version and generate the draft.",
      primary: blockers.length > 0 ? null : { label: "Prepare contract", href: "#contract" },
      blockers,
    };
  }
  if (active?.status === "submitted") {
    return { ...blank, key: "review_submission", title: "Review the client's choices", detail: `The client submitted their selection for revision ${active.revision}.`, primary: { label: "Review submission", href: `${base}/proposals/${active.id}` } };
  }
  const contactBlockers: Blocker[] =
    !f.primaryContact || f.primaryContact.archived
      ? [{ text: f.primaryContact ? "The primary contact is archived; sending needs an active one." : "Add a primary contact before sending.", link: { label: "Contacts", href: "#contacts" } }]
      : [];
  if (draft) {
    return {
      ...blank,
      key: "continue_proposal",
      title: "Continue the proposal",
      detail: `Revision ${draft.revision} is a draft. The client sees nothing until you send it.`,
      primary: { label: "Continue proposal", href: `${base}/proposals/${draft.id}` },
      blockers: contactBlockers,
    };
  }
  if (active && active.status === "sent" && !isExpired(active, f.now)) {
    return {
      ...blank,
      key: "awaiting_selection",
      title: "Waiting for the client's choices",
      detail: `Revision ${active.revision} was sent. The client hasn't submitted their choices yet.`,
      primary: null,
      secondary: { label: "View proposal", href: `${base}/proposals/${active.id}` },
      waiting: true,
    };
  }
  if (active && (isExpired(active, f.now) || active.status === "declined")) {
    return {
      ...blank,
      key: "revise_offer",
      title: "Start a revised offer",
      detail: active.status === "declined" ? "The client declined the offer." : "The offer expired before the client submitted.",
      primary: { label: "Revise offer", href: "#proposal" },
      blockers: contactBlockers,
    };
  }
  return {
    ...blank,
    key: "create_proposal",
    title: "Create a proposal",
    detail: "Start from a proposal template or a blank offer.",
    primary: { label: "Create proposal", href: "#proposal" },
    blockers: contactBlockers,
  };
}

// ---------------------------------------------------------------------------
// Overview summaries
// ---------------------------------------------------------------------------

export type Summary = { status: string; detail: string | null; link: Link; attention?: boolean };

const PROPOSAL_STATUS: Record<string, string> = {
  draft: "Draft, not sent",
  sent: "Sent, waiting for the client",
  submitted: "Submitted, ready to review",
  approved: "Approved",
  expired: "Expired",
  declined: "Declined",
  superseded: "Replaced by a newer revision",
};

export function proposalSummary(f: WorkspaceFacts): Summary {
  const { draft, active } = currentProposals(f);
  const current = draft ?? active;
  if (!current) return { status: "No proposal yet", detail: null, link: { label: "Create", href: "#proposal" } };
  const status = current === active && isExpired(current, f.now) ? "Expired" : (PROPOSAL_STATUS[current.status] ?? current.status);
  const also = draft && active && draft !== active ? `Revision ${active.revision}: ${(PROPOSAL_STATUS[active.status] ?? active.status).toLowerCase()}` : null;
  return {
    status,
    detail: [`Revision ${current.revision}`, also].filter(Boolean).join(" · "),
    link: { label: "Open", href: `/staff/${f.slug}/proposals/${current.id}` },
    attention: current.status === "submitted" && !f.archived,
  };
}

export function contractSummary(f: WorkspaceFacts, fmt: (iso: string) => string): Summary {
  const { signed, sent, draft } = currentContracts(f.contracts);
  const current = signed ?? sent ?? draft;
  if (!current) {
    return { status: f.approvalId ? "Ready to prepare" : "Not yet", detail: f.approvalId ? "The selection is approved." : "Generated once the proposal is approved.", link: { label: "Details", href: "#contract" } };
  }
  const status = current.status === "signed" ? `Signed ${current.signed_at ? fmt(current.signed_at) : ""}`.trim() : current.status === "sent" ? "Sent, waiting for signature" : "Draft, not sent";
  return { status, detail: current.label, link: { label: "Open", href: `/staff/${f.slug}/contracts/${current.id}` } };
}

export type PaymentOverview = {
  /** Which terms the figures use; never mixed across contract versions. */
  basis: string;
  rows: { label: string; value: string }[];
  booking: string;
  warning: string | null;
};

/** Read straight from the database summary; nothing is recalculated here. */
export function paymentOverview(s: PaymentSummary | null): PaymentOverview | null {
  if (!s) return null;
  const money = (cents: number) => formatCents(cents, s.currency);
  const t = s.terms;
  const rows: { label: string; value: string }[] = [];
  if (t) rows.push({ label: "Total", value: money(t.total_cents) });
  rows.push({ label: "Received", value: money(s.received_cents) });
  if (t) {
    if (t.deposit_cents > 0) {
      rows.push({ label: "Deposit", value: money(t.deposit_cents) });
      rows.push(s.deposit_outstanding_cents ? { label: "Deposit due", value: money(s.deposit_outstanding_cents) } : { label: "Deposit due", value: "Received" });
    }
    rows.push({ label: "Balance", value: s.remaining_balance_cents ? money(s.remaining_balance_cents) : "Paid in full" });
    if (s.credit_cents) rows.push({ label: "Credit", value: money(s.credit_cents) });
  }
  const b = s.booking;
  const booking =
    b.lifecycle_status === "booked"
      ? "Booking confirmed"
      : b.lifecycle_status === "awaiting_deposit"
        ? "Signed · awaiting deposit"
        : b.legacy_signed
          ? "Signed · booking not checked yet"
          : "Not booked";
  return {
    basis: t ? (t.status === "signed" ? "Signed contract terms" : "Sent contract terms (not signed yet)") : "No contract terms yet",
    rows,
    booking,
    warning: b.deposit_no_longer_met ? "Valid payments no longer cover the deposit; the booking stands." : s.other_currency_payments > 0 ? `${s.other_currency_payments} payment(s) in another currency aren't counted.` : null,
  };
}

/** "Client editing open until Oct 16, 2026, 12:00 a.m. EDT (America/Toronto)" and similar; null without a plan. */
export function planningLine(p: WorkspaceFacts["planning"]): string | null {
  if (!p.exists || !p.editing) return null;
  const e = p.editing;
  const zone = ` (${e.timezone})`;
  if (e.state === "open") return `Client editing open until ${shortInstant(e.closes_at ?? e.deadline, e.timezone)}${zone}.`;
  if (e.state === "reopened") return `Client editing reopened until ${shortInstant(e.closes_at ?? e.deadline, e.timezone)}${zone}.`;
  return `Client planning is read-only since ${shortInstant(e.deadline, e.timezone)}${zone}. Staff can still edit.`;
}

export function planningSummary(f: WorkspaceFacts): Summary {
  const event = `/staff/${f.slug}/events/${f.eventId}`;
  if (!f.planning.exists) {
    return { status: "Not set up", detail: f.lifecycle === "booked" ? "Set it up from the planning page." : "Set up automatically when the event is booked.", link: { label: "Details", href: "#planning" } };
  }
  return {
    status: f.planning.progress ? progressHeadline(f.planning.progress) : "Set up",
    detail: f.planning.editing ? (f.planning.editing.state === "open" ? "Client editing open" : f.planning.editing.state === "reopened" ? "Reopened for the client" : "Read-only for the client") : null,
    link: { label: "Open", href: `${event}/planning` },
  };
}
