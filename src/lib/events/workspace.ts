import type { PaymentSummary } from "@/lib/payments";
import { formatCents } from "@/lib/money";
import { compactInstant, shortDate } from "@/lib/dates";
import { deliveryState, type OutboxRow } from "@/lib/email/history";
import type { StaffEditing } from "@/lib/planning/cutoff";
import type { PlanProgress } from "@/lib/planning/view";

/**
 * The staff event workspace: what to do next and one-line summaries, decided
 * from the event's actual records (proposals, approval, contracts, the
 * database's payment summary and planning view), never from the lifecycle
 * label alone. Every action is a link to the existing screen or section
 * where the database still checks eligibility and asks for confirmation;
 * nothing here performs an action.
 *
 * An event booked elsewhere (bookingSource "external") follows the planning
 * workflow only: set up planning, invite the client, follow their answers,
 * run sheet. It never shows proposal, contract, signature or deposit steps.
 */

export type ProposalRecord = { id: string; revision: number; status: string; expires_at: string | null };
export type ContractRecord = { id: string; status: string; signing_mode: string; created_at: string; signed_at: string | null; label: string };

/**
 * Client access to planning: the latest planning invitation (null when none
 * was sent) and whether a client has verified, active access (from a
 * planning invitation, or for a Flux booking from the contract). Having a
 * client record alone never counts as invited.
 */
export type PlanningAccess = {
  invitation: {
    id: string;
    email: string;
    createdAt: string;
    expiresAt: string;
    revoked: boolean;
    accepted: boolean;
    acceptedAt?: string | null;
    /** The primary contact, or their email, changed since it was sent: it no longer works (the database checks the same). */
    stale?: boolean;
  } | null;
  clientHasAccess: boolean;
};

export type WorkspaceFacts = {
  slug: string;
  eventId: string;
  now: Date;
  archived: boolean;
  lifecycle: string;
  /** events.booking_source: "flux" (default) or "external" (booked elsewhere; planning only). */
  bookingSource?: string;
  /** Planning invitation state (events booked for planning, by Flux or elsewhere). */
  planningAccess?: PlanningAccess | null;
  proposals: ProposalRecord[];
  activeProposalId: string | null;
  /** The active proposal is approved and its approval is current (contracts are generated from it). */
  approvalId: string | null;
  contracts: ContractRecord[];
  /** private.event_payment_summary, or null if it could not be read. */
  payments: PaymentSummary | null;
  /** awaitingSetup: booked with Event basics only and no template chosen yet (see planAwaitingSetup). */
  planning: { exists: boolean; awaitingSetup?: boolean; progress: PlanProgress | null; editing: StaffEditing | null };
  primaryContact: { name: string; archived: boolean } | null;
  /** Legal name, address and contact email saved (contracts need them). */
  identitySaved: boolean;
  /** Published template versions a contract can be generated from (client use or DEMO). */
  usableContractVersions: number;
  /**
   * The signer has no phone number although the contract template that
   * would be used prints {{client.phone}} (generation refuses it then).
   * Null when nothing is missing.
   */
  signerPhoneMissing?: { clientId: string; name: string } | null;
  /** Event or signer details edited since the current draft or sent contract froze them, e.g. ["event date", "venue"]. */
  contractChanges?: string[];
  /**
   * This event's emails that need attention (lib/email/history: couldn't be
   * sent, bounced, marked as spam, not delivered), with the proposal or
   * contract they belong to.
   */
  emailProblems?: EmailProblem[];
  /** The business's own time zone: deadlines in another zone name it. */
  businessTimeZone?: string;
};

export type EmailProblem = { entityId: string; eventType: string; label: string; state: string };

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
  /** Something staff should know even while the next step is elsewhere (never colour alone), with where to look. */
  warning: Blocker | null;
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
  // While waiting on the client: the email they need may not have reached them.
  const undelivered = (entityId: string, types: string[]): Blocker | null => {
    const p = (f.emailProblems ?? []).find((e) => e.entityId === entityId && types.includes(e.eventType));
    return p ? { text: `The “${p.label}” email: ${p.state.toLowerCase()}. The client may not have received it.`, link: { label: "Emails", href: "#communications" } } : null;
  };

  if (f.archived) {
    return {
      ...blank,
      key: "archived",
      title: "Paused until you unarchive it",
      detail:
        f.bookingSource === "external"
          ? "Client planning is paused and an unaccepted invitation is cancelled. Its history stays available below."
          : "Client links are revoked, and proposals, contracts and payments are paused. Its history stays available below.",
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

  if (f.bookingSource === "external") return externalNextAction(f, { planningHref, runSheet, blank, undelivered });

  if (signed) {
    if (f.lifecycle === "booked") {
      const warning: Blocker | null = booking?.deposit_no_longer_met
        ? {
            text: `The booking stands, but valid payments no longer cover the deposit${f.payments?.deposit_outstanding_cents ? ` (${money(f.payments.deposit_outstanding_cents)} short)` : ""}. Check the payments.`,
            link: { label: "Payments", href: "#payments" },
          }
        : null;
      if (f.planning.exists && f.planning.awaitingSetup) {
        return {
          ...blank,
          key: "set_up_planning",
          title: "Set up planning",
          detail: "The event is booked with Event basics only. Choose a planning template; the client can't edit planning until you do.",
          primary: { label: "Set up planning", href: planningHref },
          warning,
        };
      }
      // Planning is ready but the client hasn't been told: inviting is always a separate staff step.
      const invite: Link | null = f.planningAccess && !f.planningAccess.invitation ? { label: "Send planning invitation", href: "#client-access" } : null;
      return f.planning.exists
        ? { ...blank, key: "review_planning", title: "Review planning", detail: planningNext(f, "Check the client's answers") ?? "The event is booked.", primary: { label: "Review planning", href: planningHref }, secondary: invite ?? runSheet, warning }
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
      detail: f.contractChanges?.length
        ? `The ${listOf(f.contractChanges)} changed after the contract was sent; the contract keeps the earlier details. To change the contract, void it on its page and generate a replacement.`
        : "The contract was sent. Resending, voiding and its document are on the contract page.",
      primary: null,
      secondary: { label: "View contract", href: `${base}/contracts/${sent.id}` },
      waiting: true,
      warning: undelivered(sent.id, ["contract_sent", "contract_sign_in"]),
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
      : f.contractChanges?.length
        ? {
            ...blank,
            key: "contract_outdated",
            title: "Regenerate the contract",
            detail: `The ${listOf(f.contractChanges)} changed after this draft was generated, and a draft keeps the details it was generated with. Regenerate it to use the current details. Nothing has been sent to the client.`,
            primary: { label: "Regenerate draft", href: "#contract" },
            secondary: { label: "Review draft", href: `${base}/contracts/${contractDraft.id}` },
          }
        : { ...blank, key: "review_contract", title: "Review and send the contract", detail: "A contract draft is ready. Nothing has been sent to the client.", primary: { label: "Review contract", href: `${base}/contracts/${contractDraft.id}` } };
  }
  if (f.approvalId) {
    const blockers: Blocker[] = [];
    if (!f.identitySaved) blockers.push({ text: "Your legal name, address and contact email aren't saved yet.", link: { label: "Business settings", href: `${base}/settings` } });
    if (f.usableContractVersions === 0) blockers.push({ text: "No contract template version is published yet.", link: { label: "Contract templates", href: `${base}/contract-templates` } });
    if (f.signerPhoneMissing) {
      blockers.push({
        text: `${f.signerPhoneMissing.name}, the signer, has no phone number, and your contract template includes the client's phone.`,
        link: { label: "Add phone number", href: "#contract" },
      });
    }
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
      warning: undelivered(active.id, ["proposal_sent"]),
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

/** An invitation that still works: not replaced or revoked, not expired. */
export const invitationOpen = (i: PlanningAccess["invitation"], now: Date) => Boolean(i && !i.revoked && !i.stale && new Date(i.expiresAt) > now);

export type InvitationStatus = { label: string; tone: "normal" | "pending" | "good" | "attention" };

/**
 * The invitation's state from its records and its email's outbox row: queued
 * is never shown as sent, and "sent" means the email provider accepted it.
 */
export function invitationStatus(i: PlanningAccess["invitation"], email: OutboxRow | null, now: Date): InvitationStatus {
  if (!i) return { label: "Not invited", tone: "normal" };
  if (i.revoked) return { label: "Replaced or cancelled", tone: "normal" };
  if (i.stale) return { label: "Outdated", tone: "attention" };
  if (i.accepted) return { label: "Accepted", tone: "good" };
  if (new Date(i.expiresAt) <= now) return { label: "Expired", tone: "attention" };
  if (!email) return { label: "Queued", tone: "pending" };
  const state = deliveryState(email, now);
  if (email.status === "pending" || email.status === "sending") return { label: email.attempts > 0 ? "Queued (retrying)" : "Queued", tone: "pending" };
  if (email.status === "failed") return { label: "Failed", tone: "attention" };
  if (email.status === "cancelled") return { label: "Not sent", tone: "attention" };
  if (state.attention) return { label: `Not delivered (${state.label.toLowerCase()})`, tone: "attention" };
  return { label: email.provider_status === "delivered" ? "Delivered" : "Sent", tone: state.tone === "good" ? "good" : "normal" };
}

/** The planning workflow for an event booked elsewhere (no proposal, contract or payment steps). */
function externalNextAction(
  f: WorkspaceFacts,
  h: { planningHref: string; runSheet: Link; blank: Pick<NextAction, "secondary" | "waiting" | "blockers" | "warning">; undelivered: (entityId: string, types: string[]) => Blocker | null },
): NextAction {
  const { planningHref, runSheet, blank } = h;
  const review: Link = { label: "Review planning", href: planningHref };
  if (!f.planning.exists || f.planning.awaitingSetup) {
    return {
      ...blank,
      key: "set_up_planning",
      title: "Set up planning",
      detail: "This event was booked outside Flux DJ. Choose a planning template; the client sees nothing until you invite them.",
      primary: { label: "Set up planning", href: planningHref },
    };
  }
  const access = f.planningAccess ?? { invitation: null, clientHasAccess: false };
  const progress = f.planning.progress;
  const complete = Boolean(progress && progress.requirements_total > 0 && progress.requirements_met >= progress.requirements_total);
  if (access.clientHasAccess) {
    return complete
      ? { ...blank, key: "planning_complete", title: "Planning complete", detail: "Every required answer is in. Review the answers and the run sheet.", primary: review, secondary: runSheet }
      : {
          ...blank,
          key: "monitor_planning",
          title: "Follow the client's planning",
          detail: planningNext(f, "The client is filling planning in") ?? "The client can open planning.",
          primary: review,
          secondary: runSheet,
        };
  }
  const contactBlockers: Blocker[] =
    !f.primaryContact || f.primaryContact.archived
      ? [{ text: f.primaryContact ? "The primary contact is archived; inviting needs an active one." : "Add a primary contact to invite.", link: { label: "Contacts", href: "#contacts" } }]
      : [];
  const invitation = access.invitation;
  if (invitation && invitationOpen(invitation, f.now)) {
    return {
      ...blank,
      key: "awaiting_planning_acceptance",
      title: "Waiting for the client to open planning",
      detail: `The planning invitation to ${invitation.email} hasn't been accepted yet. Its delivery status is under Client access.`,
      primary: null,
      secondary: { label: "Client access", href: "#client-access" },
      waiting: true,
      warning: h.undelivered(invitation.id, ["planning_invitation", "planning_sign_in"]),
    };
  }
  return {
    ...blank,
    key: "invite_client",
    title: invitation ? "Invite the client again" : "Invite the client",
    detail: invitation
      ? invitation.stale
        ? "The primary contact or their email changed since the last invitation, so it no longer works. Send a new one when you're ready."
        : "The last planning invitation expired or was replaced. Send a new one when you're ready."
      : "Planning is set up. Review it, then invite the client to plan online. Nothing has been sent yet.",
    primary: contactBlockers.length > 0 ? null : { label: "Send planning invitation", href: "#client-access" },
    secondary: review,
    blockers: contactBlockers,
  };
}

// ---------------------------------------------------------------------------
// Section summaries
// ---------------------------------------------------------------------------

export type PaymentOverview = {
  /** Total, received and remaining balance (and any credit) against the contract's terms; null without terms, so no total is invented. */
  figures: { label: string; value: string }[] | null;
  /** What is owed next: the deposit still due, else the balance's due date; null when nothing is owed or there are no terms. */
  next: string | null;
};

/** The payment overview, read straight from the database summary; nothing is recalculated here. */
export function paymentOverview(s: PaymentSummary | null): PaymentOverview | null {
  if (!s) return null;
  const money = (cents: number) => formatCents(cents, s.currency);
  const t = s.terms;
  if (!t) return { figures: null, next: null };
  const figures = [
    { label: "Total", value: money(t.total_cents) },
    { label: "Received", value: money(s.received_cents) },
    { label: "Balance", value: s.remaining_balance_cents ? money(s.remaining_balance_cents) : "Paid in full" },
  ];
  if (s.credit_cents) figures.push({ label: "Credit", value: money(s.credit_cents) });
  // The deposit is an amount owed on signing (it has no date of its own); the balance has the contract's due date.
  const next = s.deposit_outstanding_cents
    ? `${money(s.deposit_outstanding_cents)} still due toward the deposit`
    : s.remaining_balance_cents
      ? t.balance_due_date
        ? `Balance due ${shortDate(t.balance_due_date)}`
        : "The contract sets no balance due date"
      : null;
  return { figures, next };
}

/**
 * "Client editing closes Oct 16, 12:00 a.m." and similar, in the event's time
 * zone; its abbreviation is added when that isn't the business's own zone.
 * The time is always shown: a midnight deadline is the start of that day.
 */
export function editingLine(e: StaffEditing, opts: { now: Date; businessTimeZone?: string }): string {
  const at = (iso: string) => editingAt(iso, e, opts);
  if (e.state === "open") return `Client editing closes ${at(e.closes_at ?? e.deadline)}`;
  if (e.state === "reopened") return `Client editing reopened, closes ${at(e.closes_at ?? e.deadline)}`;
  if (e.closed_at) return `Client editing closed by staff ${at(e.closed_at)}; staff can still edit`;
  return `Client editing closed ${at(e.deadline)}; staff can still edit`;
}

const editingAt = (iso: string, e: StaffEditing, opts: { now: Date; businessTimeZone?: string }) =>
  compactInstant(iso, e.timezone, { now: opts.now, zone: Boolean(opts.businessTimeZone && opts.businessTimeZone !== e.timezone) });

/**
 * The next step's planning detail: what to do, and until when the client can
 * still edit (the Planning section states the editing status itself, so the
 * same sentence isn't shown twice). Null without a plan or a deadline.
 */
function planningNext(f: WorkspaceFacts, action: string): string | null {
  const e = f.planning.exists ? f.planning.editing : null;
  if (!e) return null;
  if (e.state === "closed") return "Client editing is closed. Check the final answers and the run sheet.";
  return `${action}; they can edit until ${editingAt(e.closes_at ?? e.deadline, e, { now: f.now, businessTimeZone: f.businessTimeZone })}`;
}


// ---------------------------------------------------------------------------
// Layout stage
// ---------------------------------------------------------------------------

/**
 * What the workspace leads with: presentation order only. It never decides
 * what is allowed (the database does) or what to do next (nextAction). Read
 * from the stored lifecycle, as eventDisplayStatus is, with a signed contract
 * refining awaiting_signature exactly as eventStatusLabel does.
 *  - booking: lead, pending_approval, awaiting_signature (draft, sent,
 *    submitted, approved, contract draft or sent): proposal and contract first.
 *  - deposit: signed but not confirmed (awaiting_deposit, or awaiting_signature
 *    with a signed contract: signed before booking rules, not checked yet):
 *    payments first.
 *  - booked: booked or completed: payments and planning first; the proposal
 *    and contract are reference documents.
 *  - external: booked elsewhere: planning only (no proposal, contract or
 *    payments), whatever the lifecycle.
 * cancelled (allowed by the database, set by nothing in the app today) keeps
 * the records' stage: booked once a contract was signed, otherwise booking.
 * Archived, completed and cancelled events keep their stage; `archived` and
 * `ended` are reported so the page can emphasise unarchiving or history.
 */
export type WorkspaceStage = "booking" | "deposit" | "booked" | "external";
export type WorkspaceLayout = { stage: WorkspaceStage; archived: boolean; ended: "completed" | "cancelled" | null };

export function workspaceStage(f: Pick<WorkspaceFacts, "archived" | "lifecycle" | "bookingSource" | "contracts">): WorkspaceLayout {
  const signed = f.contracts.some((c) => c.status === "signed");
  const ended = f.lifecycle === "completed" || f.lifecycle === "cancelled" ? f.lifecycle : null;
  const stage: WorkspaceStage =
    f.bookingSource === "external"
      ? "external"
      : f.lifecycle === "booked" || f.lifecycle === "completed"
        ? "booked"
        : f.lifecycle === "awaiting_deposit"
          ? "deposit"
          : f.lifecycle === "cancelled"
            ? signed ? "booked" : "booking"
            : signed
              ? "deposit"
              : "booking";
  return { stage, archived: f.archived, ended };
}

/** "venue", "event date and venue", "event title, event date and venue". */
function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

type Frozen = { title: string | null; date: string | null; venueName: string | null; venueAddress: string | null; clientPhone: string | null };

/**
 * What changed on the event (or the signer's phone) since a contract froze
 * its details. Signer name and email changes are already refused by the
 * send check (signer_changed), so they aren't repeated here.
 */
export function contractChanges(frozen: Frozen | null, now: { title: string; date: string; venueName: string | null; venueAddress: string | null; signerPhone: string | null }): string[] {
  if (!frozen) return [];
  const same = (a: string | null, b: string | null) => (a ?? "").trim() === (b ?? "").trim();
  const changes: string[] = [];
  if (!same(frozen.title, now.title)) changes.push("event title");
  if (!same(frozen.date, now.date)) changes.push("event date");
  if (!same(frozen.venueName, now.venueName) || !same(frozen.venueAddress, now.venueAddress)) changes.push("venue");
  if (!same(frozen.clientPhone, now.signerPhone)) changes.push("signer's phone number");
  return changes;
}
