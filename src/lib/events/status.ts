/**
 * The event status shown to staff. Booking follows the policy frozen into
 * the signed contract: "booked" once confirmed, "awaiting deposit" when
 * signed under the deposit policy with the deposit still due. A contract
 * signed before booking policies existed leaves the event awaiting_signature
 * until staff check its booking. Labels never claim a payment state.
 */
export function eventStatusLabel(lifecycleStatus: string, contractSigned: boolean): string {
  if (lifecycleStatus === "awaiting_signature" && contractSigned) return "Contract signed · booking not checked yet";
  if (lifecycleStatus === "awaiting_deposit") return "Signed · awaiting deposit";
  if (lifecycleStatus === "booked") return "Booked";
  return lifecycleStatus.replaceAll("_", " ");
}
