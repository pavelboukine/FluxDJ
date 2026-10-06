import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { CheckboxField, TextAreaField, TextField } from "@/components/app/fields";
import {
  CUTOFF_DAYS_MAX,
  CUTOFF_DAYS_MIN,
  formatInstant,
  historyLabel,
  localInputValue,
  REASON_MAX,
  type CutoffHistoryEntry,
  type StaffEditing,
} from "@/lib/planning/cutoff";
import { closeClientEditing, recalculateClientCutoff, reopenClientEditing, setClientCutoffDays } from "./actions";

const HOUR = 3_600_000;

/** Several dialogs can be open at once, so each reason field has its own id. */
function Reason({ id, placeholder }: { id: string; placeholder: string }) {
  return (
    <TextAreaField
      id={id}
      label="Reason"
      name="reason"
      required
      rows={2}
      maxLength={REASON_MAX}
      placeholder={placeholder}
      hint="Required. Kept in this event's history with your name and the time; never shown to the client."
    />
  );
}

function change(entry: CutoffHistoryEntry, timeZone: string): string {
  const show = (v: unknown) => (typeof v === "string" ? formatInstant(v, timeZone) : "none");
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  if ("reopened_until" in after) return `Reopened until: ${show(before.reopened_until)} → ${show(after.reopened_until)}`;
  if ("deadline" in after) {
    const days = typeof after.days === "number" ? ` (${after.days} days)` : "";
    return "deadline" in before ? `${show(before.deadline)} → ${show(after.deadline)}${days}` : `${show(after.deadline)}${days}`;
  }
  return "";
}

/**
 * The client's editing state for staff: the deadline, a reopening, whether
 * the deadline still matches the event's schedule, and the actions with
 * confirmations. Staff editing below is never affected.
 */
export function ClientEditingCard({ slug, eventId, editing, archived, booked }: {
  slug: string;
  eventId: string;
  editing: StaffEditing;
  archived: boolean;
  booked: boolean;
}) {
  const tz = editing.timezone;
  const deadline = formatInstant(editing.deadline, tz);
  const now = Date.parse(editing.now);
  const badge = { open: "Open", reopened: "Reopened", closed: "Read-only" }[editing.state];
  const canReopen = editing.state !== "open";

  return (
    <Card id="client-editing" className="scroll-mt-4" data-testid="client-editing">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Client editing <Badge variant={editing.state === "closed" ? "secondary" : "outline"} data-testid="client-editing-state">{badge}</Badge>
        </CardTitle>
        <CardDescription>
          When the client can change planning. You and your staff can edit after the deadline; nothing here changes answers, progress,
          the contract, payments or the booking.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1" data-testid="client-editing-summary">
          {editing.state === "open" ? (
            <p>The client can edit until <strong>{deadline}</strong>.</p>
          ) : editing.state === "reopened" ? (
            <p>
              Temporarily reopened: the client can edit until <strong>{formatInstant(editing.reopened_until!, tz)}</strong>. The normal
              deadline, {deadline}, is unchanged.
            </p>
          ) : (
            <p>The client&apos;s planning has been read-only since <strong>{deadline}</strong>. They can still read it.</p>
          )}
          <p className="text-muted-foreground">
            Deadline: {editing.cutoff_days} {editing.cutoff_days === 1 ? "day" : "days"} before the event date, at 00:00 in {tz}.
            Business default for new plans: {editing.business_days} days.
            {booked ? "" : " The client sees planning only once the event is booked."}
          </p>
        </div>

        {editing.schedule_changed ? (
          <p role="status" data-testid="schedule-changed" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
            This deadline no longer matches the event&apos;s date or time zone. With the current schedule it would be{" "}
            {formatInstant(editing.expected_deadline, tz)}. It hasn&apos;t moved; recalculate it if it should follow the event.
          </p>
        ) : null}

        {archived ? (
          <p className="text-muted-foreground">Unarchive the event to change the deadline or reopen client editing.</p>
        ) : (
          <DraftVersionProvider version={editing.version}>
            <div className="grid gap-3">
              {canReopen ? (
                <ConfirmPanel label={editing.state === "reopened" ? "Change the reopening…" : "Reopen client editing…"} title="Reopen client editing">
                  <p className="text-muted-foreground">
                    The client can edit again until the time you choose, at most {editing.reopen_max_days} days from now, then planning closes
                    again by itself. The normal deadline stays {deadline}. Saved answers are kept. Archived events and clients without
                    access stay closed. No email is sent.
                  </p>
                  <ActionForm action={reopenClientEditing.bind(null, slug, eventId)} version={editing.version} submitLabel="Reopen client editing" pendingLabel="Reopening…">
                    <TextField
                      label={`Client can edit until (${tz} time)`}
                      name="until"
                      type="datetime-local"
                      required
                      defaultValue={localInputValue(new Date(now + 48 * HOUR).toISOString(), tz)}
                      min={localInputValue(new Date(now).toISOString(), tz)}
                      max={localInputValue(new Date(now + editing.reopen_max_days * 24 * HOUR).toISOString(), tz)}
                      className="max-w-xs"
                    />
                    <Reason id="reopen-reason" placeholder="e.g. The couple needs to update the guest count" />
                  </ActionForm>
                </ConfirmPanel>
              ) : (
                <p className="text-muted-foreground" data-testid="already-open">
                  Client editing is already open until the deadline, so there is nothing to reopen. To give more time, change the deadline.
                </p>
              )}
              {editing.reopen_active ? (
                <ConfirmPanel label="Close client editing now…" title="Close client editing now">
                  <p className="text-muted-foreground">
                    Ends the reopening immediately: the client&apos;s planning becomes read-only again. What they saved is kept, and you can
                    still edit everything.
                  </p>
                  <ActionForm action={closeClientEditing.bind(null, slug, eventId)} version={editing.version} submitLabel="Close client editing" pendingLabel="Closing…" variant="destructive">
                    <Reason id="close-reason" placeholder="e.g. Changes received" />
                  </ActionForm>
                </ConfirmPanel>
              ) : null}
              <ConfirmPanel label="Change the deadline…" title="Change this event's deadline">
                <p className="text-muted-foreground">
                  Sets the deadline to that many days before the event date, at 00:00 in {tz}. Only this event changes. If the new deadline
                  has already passed, the client&apos;s planning becomes read-only immediately (a reopening still applies until it ends).
                </p>
                <ActionForm action={setClientCutoffDays.bind(null, slug, eventId)} version={editing.version} submitLabel="Change the deadline" pendingLabel="Saving…">
                  <TextField
                    key={editing.cutoff_days}
                    label="Days before the event"
                    name="days"
                    type="number"
                    inputMode="numeric"
                    required
                    min={CUTOFF_DAYS_MIN}
                    max={CUTOFF_DAYS_MAX}
                    step={1}
                    defaultValue={editing.cutoff_days}
                    className="max-w-[10rem]"
                    hint={`A whole number from ${CUTOFF_DAYS_MIN} (the start of the event day) to ${CUTOFF_DAYS_MAX}.`}
                  />
                  <Reason id="deadline-reason" placeholder="e.g. The venue needs the timeline earlier" />
                </ActionForm>
              </ConfirmPanel>
              {editing.schedule_changed ? (
                <ConfirmPanel label="Recalculate the deadline…" title="Recalculate the deadline">
                  <p className="text-muted-foreground">
                    Moves the deadline from {deadline} to {formatInstant(editing.expected_deadline, tz)}: {editing.cutoff_days} days before
                    the event&apos;s current date, in its current time zone. If that has already passed, the client&apos;s planning becomes
                    read-only immediately.
                  </p>
                  <ActionForm action={recalculateClientCutoff.bind(null, slug, eventId)} version={editing.version} submitLabel="Recalculate the deadline" pendingLabel="Saving…">
                    <CheckboxField name="confirm" label="Move the deadline to match the event's current date." />
                    <Reason id="recalculate-reason" placeholder="e.g. The wedding moved to a new date" />
                  </ActionForm>
                </ConfirmPanel>
              ) : null}
            </div>
          </DraftVersionProvider>
        )}

        {editing.history.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-muted-foreground">History</summary>
            <ul className="mt-2 grid gap-2" data-testid="client-editing-history">
              {editing.history.map((h, i) => (
                <li key={i} className="grid gap-0.5 border-l-2 pl-3">
                  <span className="font-medium">{historyLabel(h.action)}</span>
                  <span className="text-muted-foreground">{formatInstant(h.at, tz)} · {h.actor}</span>
                  {change(h, tz) ? <span>{change(h, tz)}</span> : null}
                  {h.reason ? <span className="[overflow-wrap:anywhere]">Reason: {h.reason}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
