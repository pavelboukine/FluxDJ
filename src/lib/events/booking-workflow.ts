/**
 * The booking steps an event uses, chosen when it is created. Stored as
 * events.booking_source and events.contract_first; the database rejects any
 * combination that isn't one of these three.
 *
 *   full            proposal, contract and deposit, then planning
 *   contract_first  a contract with no proposal, with stated terms or none
 *   external        booked elsewhere: planning only
 */
export type BookingWorkflow = "full" | "contract_first" | "external";

export function bookingWorkflowFrom(contract: boolean, proposal: boolean): BookingWorkflow {
  if (!contract) return "external";
  return proposal ? "full" : "contract_first";
}

/** The columns for a workflow, or an error for a proposal with no contract (the form never sends that). */
export function readBookingWorkflow(contract: boolean, proposal: boolean):
  | { ok: true; values: { booking_source: "flux" | "external"; contract_first: boolean } }
  | { ok: false; error: string } {
  if (!contract && proposal) return { ok: false, error: "A proposal needs a contract. Turn Contract on, or turn Proposal off." };
  const workflow = bookingWorkflowFrom(contract, proposal);
  return { ok: true, values: { booking_source: workflow === "external" ? "external" : "flux", contract_first: workflow === "contract_first" } };
}
