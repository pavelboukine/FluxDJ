"use client";

import { useState } from "react";
import type { PickerClient } from "@/components/app/client-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bookingFlowSteps, bookingWorkflowFrom, primaryContactHelp } from "@/lib/events/booking-workflow";
import { PrimaryContact } from "./primary-contact";

const choice =
  "grid min-h-11 flex-1 basis-60 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2.5 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

/**
 * How the new event is booked, and its primary contact, whose role follows from
 * that. The form sends uses_contract and uses_proposal; the server maps them
 * (readBookingWorkflow) and the database rejects anything invalid. The proposal
 * preference is kept while "Already booked elsewhere" is selected.
 */
export function BookingAndContact({
  search,
  initial,
  hasClients,
  contractsNeedPhone,
  proposalDefault,
}: {
  search: (query: string) => Promise<PickerClient[]>;
  initial: PickerClient | null;
  hasClients: boolean;
  contractsNeedPhone: boolean;
  /** The business's preference. Only the starting value: a change here is never overwritten. */
  proposalDefault: boolean;
}) {
  const [elsewhere, setElsewhere] = useState(false);
  const [proposal, setProposal] = useState(proposalDefault);
  const workflow = bookingWorkflowFrom(!elsewhere, proposal);
  return (
    <>
      <fieldset className="grid gap-3" data-testid="booking-source">
        <legend className="mb-2 text-sm font-medium">How is this event being booked?</legend>
        <div className="flex flex-wrap gap-2">
          <label className={choice}>
            <input type="radio" name="booking_choice" value="flux" checked={!elsewhere} onChange={() => setElsewhere(false)} className="mt-0.5 size-4 accent-primary" />
            <span className="font-medium">Book through Flux DJ</span>
            <span className="col-start-2 text-muted-foreground">Send an agreement, confirm the booking, and plan the event.</span>
          </label>
          <label className={choice}>
            <input type="radio" name="booking_choice" value="external" checked={elsewhere} onChange={() => setElsewhere(true)} className="mt-0.5 size-4 accent-primary" />
            <span className="font-medium">Already booked elsewhere</span>
            <span className="col-start-2 text-muted-foreground">Skip proposals and contracts. Use Flux DJ for event planning.</span>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">You can&apos;t switch between these after the event is created.</p>
        {elsewhere ? null : (
          <div className="grid gap-2">
            <input type="hidden" name="uses_contract" value="on" />
            <label className="grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 -mx-1.5 rounded-lg px-1.5 py-1 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
              <input type="checkbox" name="uses_proposal" checked={proposal} onChange={(e) => setProposal(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
              <span className="font-medium">Send a proposal first</span>
              <span className="col-start-2 text-muted-foreground">Let the client review packages and pricing before their contract.</span>
            </label>
            <ol aria-label="Booking steps for this event" aria-live="polite" className="flex max-w-md pt-1" data-testid="booking-flow">
              {bookingFlowSteps(workflow).map((step, i) => (
                <li key={step} className="relative flex min-w-0 flex-1 flex-col items-center gap-1 text-center">
                  {/* Joins this step to the one before it, from circle edge to circle edge. */}
                  {i > 0 ? <span aria-hidden className="absolute top-3 right-[calc(50%+0.75rem)] h-px w-[calc(100%-1.5rem)] bg-sky-600/40" /> : null}
                  <span className="flex size-6 items-center justify-center rounded-full bg-sky-100 text-xs font-semibold text-sky-900 tabular-nums dark:bg-sky-900 dark:text-sky-100">{i + 1}</span>
                  <span className="text-[11px] leading-tight font-medium max-[359px]:text-[10px] sm:text-xs">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </fieldset>
      <Card className="bg-muted/30">
        <CardHeader><CardTitle className="text-base">Primary contact</CardTitle></CardHeader>
        <CardContent>
          <PrimaryContact search={search} initial={initial} hasClients={hasClients} contractsNeedPhone={contractsNeedPhone} help={primaryContactHelp(workflow)} />
        </CardContent>
      </Card>
    </>
  );
}
