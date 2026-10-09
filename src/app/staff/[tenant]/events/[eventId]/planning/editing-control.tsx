import { Lock, LockOpen } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { TextAreaField, TextField } from "@/components/app/fields";
import { NavLink } from "@/components/planning/plan-navigation";
import { CLIENT_EDITING_SECTION } from "@/lib/planning/navigation";
import { formatInstant, localInputValue, REASON_MAX, staffEditingText, type StaffEditing } from "@/lib/planning/cutoff";
import { cn } from "@/lib/utils";
import { closeClientEditing, reopenClientEditing } from "./actions";

const HOUR = 3_600_000;

function Note({ id }: { id: string }) {
  return (
    <TextAreaField
      id={id}
      label="Note (optional)"
      name="reason"
      rows={2}
      maxLength={REASON_MAX}
      hint="Kept in this event's history with your name and the time; never shown to the client."
    />
  );
}

/**
 * Whether the client can edit planning right now, and the one action that
 * changes it. Close works whatever the deadline and stays in force until
 * staff open editing again. Open lifts a close before the deadline (the
 * deadline ends it), or after the deadline reopens until a chosen time (at
 * most 14 days): never open-ended. The database applies both at once to the
 * client's next save, including from a tab opened earlier. Staff editing is
 * never affected.
 */
export function EditingControl({ slug, eventId, editing, archived, booked }: {
  slug: string;
  eventId: string;
  editing: StaffEditing;
  archived: boolean;
  booked: boolean;
}) {
  const tz = editing.timezone;
  const open = editing.state !== "closed";
  const { title, detail } = staffEditingText(editing);
  const now = Date.parse(editing.now);
  const deadlinePassed = now >= Date.parse(editing.deadline);
  const Icon = open ? LockOpen : Lock;

  return (
    <section
      aria-labelledby="client-editing-title"
      data-testid="client-editing-control"
      data-state={editing.state}
      className={cn(
        "grid gap-3 rounded-xl border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start",
        open ? "border-emerald-600/40 bg-emerald-500/5" : "bg-muted/40",
      )}
    >
      <div className="grid min-w-0 gap-1 text-sm">
        <h2 id="client-editing-title" className="flex items-center gap-2 text-base font-semibold" data-testid="client-editing-status">
          <Icon aria-hidden className={cn("size-4 shrink-0", open ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")} />
          {title}
        </h2>
        <p className="[overflow-wrap:anywhere]" data-testid="client-editing-detail">{detail}</p>
        <p className="text-muted-foreground">
          Normal deadline: {formatInstant(editing.deadline, tz)}.{" "}
          {booked ? "" : "The client sees planning only once the event is booked. "}
          You can always edit.{" "}
          <NavLink view={CLIENT_EDITING_SECTION} className="rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Deadline and history
          </NavLink>
        </p>
      </div>

      {archived ? (
        <p className="text-sm text-muted-foreground">Unarchive the event to open or close client editing.</p>
      ) : (
        // Keyed by state: after an action the other button appears, closed.
        <div key={editing.state} className="sm:max-w-sm">
          {open ? (
            <ConfirmPanel label="Close client editing…" title="Close client editing">
              <p className="text-muted-foreground">
                The client&apos;s planning becomes read-only now, including in a page they already have open: their next save is refused
                and nothing unsaved is stored. It stays closed until you open it again, even before the deadline. They can still read
                everything, and you can still edit.
              </p>
              <ActionForm action={closeClientEditing.bind(null, slug, eventId)} version={editing.version} submitLabel="Close client editing" pendingLabel="Closing…" variant="destructive">
                <Note id="close-note" />
              </ActionForm>
            </ConfirmPanel>
          ) : (
            <ConfirmPanel label="Open client editing…" title="Open client editing" variant="default">
              {deadlinePassed ? (
                <p className="text-muted-foreground">
                  The deadline has passed, so opening is temporary: the client can edit until the time you choose (at most{" "}
                  {editing.reopen_max_days} days from now), then planning closes again by itself. The deadline doesn&apos;t move.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  The client can edit again now, until the normal deadline ({formatInstant(editing.deadline, tz)}).
                </p>
              )}
              <ActionForm action={reopenClientEditing.bind(null, slug, eventId)} version={editing.version} submitLabel="Open client editing" pendingLabel="Opening…">
                {deadlinePassed ? (
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
                ) : null}
                <Note id="open-note" />
              </ActionForm>
            </ConfirmPanel>
          )}
        </div>
      )}
    </section>
  );
}
