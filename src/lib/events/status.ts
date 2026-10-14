/** The staff label for an event booked outside Flux DJ (events.booking_source = 'external'). */
export const BOOKED_EXTERNALLY = "Booked externally";
/** What that label means, wherever there is room to say it. */
export const BOOKED_EXTERNALLY_DETAIL = "Booked outside Flux DJ. Planning is managed here.";

/**
 * The event status shown to staff. Booking follows the policy frozen into
 * the signed contract: "booked" once confirmed, "awaiting deposit" when
 * signed under the deposit policy with the deposit still due. A contract
 * signed before booking policies existed leaves the event awaiting_signature
 * until staff check its booking. Labels never claim a payment state.
 */
export function eventStatusLabel(lifecycleStatus: string, contractSigned: boolean): string {
  // The lists pass "external" for an event booked elsewhere (it has no Flux booking stage).
  if (lifecycleStatus === "external") return BOOKED_EXTERNALLY;
  if (lifecycleStatus === "awaiting_signature" && contractSigned) return "Contract signed · booking not checked yet";
  if (lifecycleStatus === "awaiting_deposit") return "Signed · awaiting deposit";
  if (lifecycleStatus === "booked") return "Booked";
  return lifecycleStatus.replaceAll("_", " ");
}

/** What an event's own records say, as read by the staff lists and event page. Nothing here is stored. */
export type EventRecords = {
  lifecycle: string;
  /** events.booking_source; absent from an older database (every event was then a Flux booking). */
  bookingSource?: string | null;
  /** The active proposal's status ("expired" once a sent offer's expiry has passed), or null. */
  proposalStatus: string | null;
  /** An editable proposal draft exists (a first offer or a revision being prepared). */
  proposalDraft: boolean;
  /** The current contract: signed, else sent, else draft; null when none. */
  contractStatus: "signed" | "sent" | "draft" | null;
};

/**
 * One short status for an event, derived from its records rather than a
 * parallel state machine: the stored lifecycle decides the stage (booking
 * still follows the frozen booking policy, so a signed contract with the
 * deposit due reads "Signed · awaiting deposit", never "Booked"), and the
 * proposal and contract records only refine the label within that stage.
 * An event booked elsewhere has no Flux booking stage at all: it is
 * "Booked externally", never a proposal, contract or payment state.
 */
export function eventDisplayStatus(r: EventRecords): string {
  if (r.bookingSource === "external") return BOOKED_EXTERNALLY;
  switch (r.lifecycle) {
    case "booked":
    case "awaiting_deposit":
      return eventStatusLabel(r.lifecycle, true);
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "awaiting_signature":
      if (r.contractStatus === "signed") return eventStatusLabel(r.lifecycle, true);
      if (r.contractStatus === "sent") return "Contract sent";
      if (r.contractStatus === "draft") return "Contract draft";
      return "Approved · contract to prepare";
    case "pending_approval":
      return "Choices submitted · review";
    case "lead":
      if (r.proposalDraft) return r.proposalStatus ? "Revised proposal in progress" : "Proposal draft";
      if (r.proposalStatus === "sent") return "Proposal sent";
      if (r.proposalStatus === "expired") return "Proposal expired";
      if (r.proposalStatus === "declined") return "Proposal declined";
      return "New inquiry";
    default:
      return eventStatusLabel(r.lifecycle, r.contractStatus === "signed");
  }
}
