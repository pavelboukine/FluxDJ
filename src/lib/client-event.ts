import { homeCard, type HomeEvent, type HomeTone } from "@/lib/client-home";
import { formatCents } from "@/lib/money";

/**
 * The client's event hub (/{slug}/events/{eventId}): its status (the same
 * words as the event's card on /my) and the one next step to recommend.
 * Pure: it only words the facts the client views returned (see
 * client-event.server). It adds no booking, payment, signing or access rule:
 * a booking is said to be confirmed only when the event's own status is
 * booked, never because a contract was signed.
 */

export const eventHubPath = (slug: string, eventId: string) => `/${slug}/events/${eventId}`;

export type HubAction = { label: string; href: string };
export type HubStep = { title: string; text: string | null; action: HubAction | null };

/** The facts the hub words: the event, and its contract and planning when this client may see them. */
export type HubFacts = {
  home: HomeEvent;
  contract: { id: string; status: "sent" | "signed"; totalCents: number; signable: boolean } | null;
  plan: { editing: "open" | "reopened" | "closed" | null; complete: boolean } | null;
};

/** The same status as the event's card on /my. */
export function hubStatus(home: HomeEvent): { label: string; tone: HomeTone } {
  const card = homeCard(home);
  return { label: card.status, tone: card.tone };
}

/** A legitimate $0 booking: nothing to pay, so no deposit or balance wording. */
export const noPaymentDue = (contract: { totalCents: number } | null) => contract !== null && contract.totalCents === 0;

export function hubNextStep(f: HubFacts): HubStep {
  const e = f.home;
  const dj = e.tenantName;
  const contractHref = f.contract ? `/${e.tenantSlug}/contracts/${f.contract.id}` : null;
  const planHref = `/${e.tenantSlug}/planning/${e.eventId}`;

  // A contract waiting for this client, who is its signer.
  if (f.contract?.status === "sent") {
    return f.contract.signable
      ? { title: "Review and sign your contract", text: `Read the agreement and payment terms from ${dj}, then sign online.`, action: { label: "Review and sign", href: contractHref! } }
      : { title: "Read your contract", text: `This contract can't be signed online. ${dj} will send you an updated contract to sign.`, action: { label: "Read contract", href: contractHref! } };
  }

  // Cancelled, however it was booked: no planning or payment step.
  if (e.lifecycle === "cancelled") return { title: "This event was cancelled", text: `Contact ${dj} with any questions.`, action: null };

  const booked = e.bookingSource === "external" || e.lifecycle === "booked" || e.lifecycle === "completed";
  if (booked) {
    if (!f.plan) {
      return e.lifecycle === "completed"
        ? { title: "Your event has taken place", text: `Thank you for celebrating with ${dj}.`, action: null }
        : { title: "Your DJ is getting planning ready", text: `${dj} will let you know when your event planning opens.`, action: null };
    }
    if (f.plan.editing === "closed") {
      return { title: "Planning is closed for changes", text: `Everything you planned stays here to read. Contact ${dj} for changes.`, action: { label: "View your plan", href: planHref } };
    }
    // Always the planning overview (progress, sections, then its own Continue planning), never a section directly.
    return f.plan.complete
      ? { title: "Your plan is complete", text: "Every required planning detail is filled in. You can still review and change it while planning is open.", action: { label: "Review your plan", href: planHref } }
      : { title: "Plan your event", text: `Share the timing, music and moments that matter so ${dj} can get everything ready.`, action: { label: "Open planning", href: planHref } };
  }

  switch (e.lifecycle) {
    case "awaiting_deposit": {
      const owed = e.payments?.depositOutstandingCents ? formatCents(e.payments.depositOutstandingCents, e.payments.currency) : null;
      return {
        title: "Pay your deposit",
        text: owed
          ? `Your contract is signed. ${owed} deposit is still to pay, directly to ${dj} as arranged (Flux DJ doesn't take payments). Your booking is confirmed once they record it.`
          : `Your contract is signed. Pay your deposit directly to ${dj} as arranged; they confirm your booking once they record it.`,
        // Payment details are on this page, for the signer only.
        action: f.contract ? { label: "See payment details", href: "#payments" } : null,
      };
    }
    case "awaiting_signature":
      return f.contract?.status === "signed"
        ? { title: "Booking not confirmed yet", text: `Your contract is signed. ${dj} will confirm your booking.`, action: null }
        : { title: "Your contract is on its way", text: `${dj} emails the contract to the person signing for this event.`, action: null };
    case "pending_approval":
      return { title: "Your choices are with your DJ", text: `${dj} is reviewing your choices. A contract follows if they approve them.`, action: null };
    case "lead":
      return { title: "Your proposal", text: `Proposals from ${dj} open from the link in your email.`, action: null };
    default:
      return { title: "Your event", text: null, action: null };
  }
}
