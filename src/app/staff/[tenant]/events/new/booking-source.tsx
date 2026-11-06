"use client";

import { useState } from "react";
import { bookingWorkflowFrom, type BookingWorkflow } from "@/lib/events/booking-workflow";

const WORKFLOW_TEXT: Record<BookingWorkflow, string> = {
  full: "The full Flux DJ workflow: proposal, contract and deposit, then planning.",
  contract_first: "No proposal is needed. The next step is preparing the contract, then the client signs it and planning follows.",
  external: "This event is already booked elsewhere. Flux DJ is used for planning only, with no proposal, contract or deposit here.",
};

/**
 * Which booking steps the new event uses. A proposal is part of the contract
 * path, so it can only be on while Contract is on. The server maps the choice
 * again (readBookingWorkflow), and the database rejects anything invalid.
 */
export function BookingSourceField() {
  const [contract, setContract] = useState(true);
  const [proposal, setProposal] = useState(true);
  const workflow = bookingWorkflowFrom(contract, proposal);
  const row = "grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-lg px-1 py-1.5 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
  return (
    <fieldset className="grid gap-2 rounded-lg border p-3" data-testid="booking-source">
      <legend className="px-1 text-sm font-medium">Booking steps</legend>
      <label className={row}>
        <input
          type="checkbox"
          name="uses_contract"
          checked={contract}
          onChange={(e) => {
            setContract(e.target.checked);
            // A proposal leads to a contract, so it can't stay on without one.
            setProposal(e.target.checked);
          }}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="font-medium">Contract</span>
        <span className="col-start-2 text-muted-foreground">The client signs an agreement online.</span>
      </label>
      <label className={`${row} ml-6 ${contract ? "" : "cursor-not-allowed opacity-60"}`}>
        <input
          type="checkbox"
          name="uses_proposal"
          checked={proposal}
          disabled={!contract}
          onChange={(e) => setProposal(e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="font-medium">Proposal</span>
        <span className="col-start-2 text-muted-foreground">The client reviews and selects a package first.</span>
      </label>
      <p className="px-1 text-sm" role="status" data-testid="booking-workflow-note">{WORKFLOW_TEXT[workflow]}</p>
      <p className="px-1 text-xs text-muted-foreground">
        {workflow === "external"
          ? "This can't be changed after the event is created."
          : "You can turn the proposal on or off until a proposal or contract is started. The contract step can't be changed after the event is created."}
      </p>
    </fieldset>
  );
}
