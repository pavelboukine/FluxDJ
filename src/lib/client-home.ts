import { dateIn } from "@/lib/dates";

/**
 * The client home (/my): what to show for each event the signed-in client
 * can open.
 *
 * Everything comes from client views that already decide access and status
 * in the database:
 *  - my_events: events with verified, unrevoked access (never archived or
 *    suspended), with their lifecycle status and booking source (an event
 *    booked outside Flux DJ has no proposal, contract or payment here);
 *  - my_contracts + client_contract_view: a contract, only for its intended
 *    signer;
 *  - client_payment_summary: the signer's booking status and payment figures;
 *  - my_plans + client_planning_view: planning, only once the database allows
 *    it, and whether client editing is open.
 * This module only words each event's status from those facts. It adds no
 * booking, payment or signing rule.
 */

export type HomeContract = {
  id: string;
  status: "sent" | "signed";
  /** Online signing is available for this contract (its frozen signing mode isn't "none"). */
  signable: boolean;
  pdfReady: boolean;
  pdfPending: boolean;
};

export type HomePayments = {
  currency: string;
  bookingStatus: "booked" | "awaiting_deposit" | null;
  depositOutstandingCents: number | null;
};

export type HomeEvent = {
  eventId: string;
  tenantSlug: string;
  tenantName: string;
  title: string;
  eventDate: string;
  timezone: string;
  venueName: string | null;
  lifecycle: string;
  /** "external": booked outside Flux DJ, planning only. Absent (older database) or "flux": a Flux booking. */
  bookingSource?: string | null;
  /** Present only when this user is the contract's signer (only signers can read contracts). */
  contract: HomeContract | null;
  payments: HomePayments | null;
  /** Present only when the database allows this client to open planning. */
  plan: { editing: "open" | "reopened" | "closed" | null } | null;
};

export type HomeTone = "action" | "waiting" | "done" | "neutral";

/**
 * An event's status, the same pill on /my and its hub. What happens next, and
 * the way to do it, is the hub's next step (lib/client-event hubNextStep).
 */
export type HomeCard = { status: string; tone: HomeTone };

export function homeCard(e: HomeEvent): HomeCard {
  // A contract waiting for this user, who is its signer.
  if (e.contract?.status === "sent") {
    return e.contract.signable ? { status: "Contract ready to sign", tone: "action" } : { status: "Contract ready to read", tone: "waiting" };
  }
  // Cancelled, however it was booked.
  if (e.lifecycle === "cancelled") return { status: "Cancelled", tone: "neutral" };
  // Booked outside Flux DJ: nothing to sign or pay here, only planning.
  if (e.bookingSource === "external") return { status: "Booked", tone: "done" };

  switch (e.lifecycle) {
    case "lead":
      return { status: "Proposal stage", tone: "neutral" };
    case "pending_approval":
      return { status: "Choices submitted", tone: "waiting" };
    case "awaiting_signature":
      // Signed before booking rules existed: the DJ confirms the booking. Otherwise no contract this
      // user can read yet: none is ready, or it is for another person to sign.
      return e.contract?.status === "signed"
        ? { status: "Contract signed · booking not confirmed yet", tone: "waiting" }
        : { status: "Contract stage", tone: "waiting" };
    case "awaiting_deposit":
      return { status: "Signed · awaiting deposit", tone: "waiting" };
    case "booked":
      return { status: "Booked", tone: "done" };
    case "completed":
      return { status: "Completed", tone: "neutral" };
    default:
      return { status: e.lifecycle.replaceAll("_", " "), tone: "neutral" };
  }
}

/** Upcoming (today or later in the event's own time zone), soonest first; past events, most recent first. */
export function splitByDate<T extends { eventDate: string; timezone: string }>(events: T[], now: Date): { upcoming: T[]; past: T[] } {
  const today = (e: T) => {
    try {
      return dateIn(e.timezone, now);
    } catch {
      return now.toISOString().slice(0, 10);
    }
  };
  const upcoming = events.filter((e) => e.eventDate >= today(e)).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const past = events.filter((e) => e.eventDate < today(e)).sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  return { upcoming, past };
}
