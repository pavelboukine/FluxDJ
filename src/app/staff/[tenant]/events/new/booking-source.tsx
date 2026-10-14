/**
 * How the new event is booked. Chosen once: the database never lets it
 * change afterwards. "Already booked elsewhere" is the staff member's own
 * affirmation; it creates no proposal, contract, signature or payment.
 */
export function BookingSourceField() {
  const option =
    "grid min-h-11 flex-1 basis-60 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2.5 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
  return (
    <fieldset className="grid gap-2" data-testid="booking-source">
      <legend className="mb-2 text-sm font-medium">How is this event being booked?</legend>
      <div className="flex flex-wrap gap-2">
        <label className={option}>
          <input type="radio" name="booking_source" value="flux" defaultChecked className="mt-0.5 size-4 accent-primary" />
          <span className="font-medium">Through Flux DJ</span>
          <span className="col-start-2 text-muted-foreground">Proposal, contract and deposit, then planning.</span>
        </label>
        <label className={option}>
          <input type="radio" name="booking_source" value="external" className="mt-0.5 size-4 accent-primary" />
          <span className="font-medium">Already booked elsewhere</span>
          <span className="col-start-2 text-muted-foreground">
            Booked through an agency or directly. No proposal, contract or deposit here: you plan the event with the client.
          </span>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">This can&apos;t be changed after the event is created.</p>
    </fieldset>
  );
}
