/**
 * The event status shown to staff. The stored lifecycle is not changed by
 * signing: a signed contract leaves the event awaiting_signature until the
 * booking/deposit policy confirms it. So the label reflects the signed
 * contract, says booking confirmation is still pending, and never claims a
 * booking or a payment state.
 */
export function eventStatusLabel(lifecycleStatus: string, contractSigned: boolean): string {
  if (lifecycleStatus === "awaiting_signature" && contractSigned) return "Contract signed · booking confirmation pending";
  return lifecycleStatus.replaceAll("_", " ");
}
