import { dateIn } from "@/lib/dates";
import { formatCents } from "@/lib/money";

/**
 * The client home (/my): what to show for each event the signed-in client
 * can open, and the one action to recommend.
 *
 * Everything comes from client views that already decide access and status
 * in the database:
 *  - my_events: events with verified, unrevoked access (never archived or
 *    suspended), with their lifecycle status;
 *  - my_contracts + client_contract_view: a contract, only for its intended
 *    signer;
 *  - client_payment_summary: the signer's booking status and payment figures;
 *  - my_plans + client_planning_view: planning, only once the database allows
 *    it, and whether client editing is open.
 * This module only chooses wording and links from those facts. It adds no
 * booking, payment or signing rule, and never offers payment (Flux DJ takes
 * none) or signing to someone who isn't the signer.
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
  /** Present only when this user is the contract's signer (only signers can read contracts). */
  contract: HomeContract | null;
  payments: HomePayments | null;
  /** Present only when the database allows this client to open planning. */
  plan: { editing: "open" | "reopened" | "closed" | null } | null;
};

export type HomeAction = { label: string; href: string; kind: "link" | "pdf" };
export type HomeTone = "action" | "waiting" | "done" | "neutral";

export type HomeCard = {
  status: string;
  tone: HomeTone;
  /** One or two sentences: what is happening and who acts next. */
  note: string | null;
  primary: HomeAction | null;
  secondary: HomeAction[];
};

export function homeCard(e: HomeEvent): HomeCard {
  const dj = e.tenantName;
  const contractHref = e.contract ? `/${e.tenantSlug}/contracts/${e.contract.id}` : null;
  const pdf: HomeAction | null =
    e.contract?.status === "signed" && e.contract.pdfReady ? { label: "Download signed PDF", href: `${contractHref}/signed-pdf`, kind: "pdf" } : null;
  const planAction: HomeAction | null = e.plan
    ? e.plan.editing === "closed"
      ? { label: "View planning", href: `/${e.tenantSlug}/planning/${e.eventId}`, kind: "link" }
      : { label: "Plan your event", href: `/${e.tenantSlug}/planning/${e.eventId}`, kind: "link" }
    : null;
  const signedContract: HomeAction | null = e.contract?.status === "signed" ? { label: "View signed contract", href: contractHref!, kind: "link" } : null;
  const secondary = (...actions: (HomeAction | null)[]) => actions.filter((a): a is HomeAction => a !== null);

  // A contract waiting for this user, who is its signer.
  if (e.contract?.status === "sent") {
    return e.contract.signable
      ? {
          status: "Contract ready to sign",
          tone: "action",
          note: `Read your contract from ${dj} and sign it online.`,
          primary: { label: "Review and sign contract", href: contractHref!, kind: "link" },
          secondary: [],
        }
      : {
          status: "Contract ready to read",
          tone: "waiting",
          note: `This contract can't be signed online. ${dj} will send you an updated contract to sign.`,
          primary: { label: "Read contract", href: contractHref!, kind: "link" },
          secondary: [],
        };
  }

  switch (e.lifecycle) {
    case "lead":
      return { status: "Proposal stage", tone: "neutral", note: `Proposals from ${dj} open from the link in your email.`, primary: null, secondary: [] };
    case "pending_approval":
      return { status: "Choices submitted", tone: "waiting", note: `${dj} is reviewing your choices. A contract follows if they approve them.`, primary: null, secondary: [] };
    case "awaiting_signature":
      if (e.contract?.status === "signed") {
        // Signed before booking rules existed: the DJ confirms the booking.
        return { status: "Contract signed · booking not confirmed yet", tone: "waiting", note: `${dj} will confirm your booking.`, primary: signedContract, secondary: secondary(pdf) };
      }
      // No contract this user can read: none is ready yet, or it is for another person to sign.
      return { status: "Contract stage", tone: "waiting", note: `${dj} emails the contract to the person signing for this event.`, primary: null, secondary: [] };
    case "awaiting_deposit": {
      const owed = e.payments?.depositOutstandingCents ? formatCents(e.payments.depositOutstandingCents, e.payments.currency) : null;
      return {
        status: "Signed · awaiting deposit",
        tone: "waiting",
        note: owed
          ? `${owed} deposit still to pay, as arranged with ${dj}. They confirm your booking once they record it.`
          : `${dj} confirms your booking once they record your deposit.`,
        primary: e.contract ? { label: "View deposit details", href: `${contractHref}#payments`, kind: "link" } : null,
        secondary: secondary(e.contract ? signedContract : null, pdf),
      };
    }
    case "booked":
      return {
        status: "Booked",
        tone: "done",
        note: planAction ? (e.plan?.editing === "closed" ? "Planning is closed for changes. You can still read it." : null) : `${dj} will be in touch about the next steps.`,
        primary: planAction ?? signedContract,
        secondary: secondary(planAction ? signedContract : null, pdf),
      };
    case "completed":
      return { status: "Completed", tone: "neutral", note: null, primary: planAction ?? signedContract, secondary: secondary(planAction ? signedContract : null, pdf) };
    case "cancelled":
      return { status: "Cancelled", tone: "neutral", note: `Contact ${dj} with any questions.`, primary: null, secondary: [] };
    default:
      return { status: e.lifecycle.replaceAll("_", " "), tone: "neutral", note: null, primary: planAction ?? signedContract, secondary: secondary(pdf) };
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
