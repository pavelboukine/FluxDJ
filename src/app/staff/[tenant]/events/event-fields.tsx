import { SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { EVENT_TYPES, eventDetailsKey } from "./event-form";

type Ev = { title: string; event_type: string; event_date: string; timezone: string; venue_name: string | null; venue_address: string | null; internal_notes: string | null; dj_name: string | null };

export function EventFields({ event, defaultTimezone }: { event?: Ev; defaultTimezone: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {event ? <input type="hidden" name="event_original" value={eventDetailsKey(event)} /> : null}
      <TextField label="Title" name="title" required maxLength={200} defaultValue={event?.title} placeholder="Alex & Sam wedding" />
      <SelectField label="Type" name="event_type" defaultValue={event?.event_type ?? "wedding"} options={EVENT_TYPES.map(([value, label]) => ({ value, label }))} />
      <TextField label="Date" name="event_date" type="date" required defaultValue={event?.event_date} />
      <TextField label="Timezone" name="timezone" required defaultValue={event?.timezone ?? defaultTimezone} hint="Governs planning deadlines. IANA name, e.g. America/Toronto." />
      <TextField label="Venue name" name="venue_name" maxLength={200} defaultValue={event?.venue_name ?? ""} />
      <TextField label="Venue address" name="venue_address" maxLength={500} defaultValue={event?.venue_address ?? ""} />
      <TextField
        className="sm:col-span-2"
        label="DJ for this event (optional)"
        name="dj_name"
        maxLength={80}
        defaultValue={event?.dj_name ?? ""}
        placeholder="DJ Boukine"
        hint="Shown to the client in planning where it asks who does what, for example “DJ Boukine (your DJ) will be the MC”. Leave empty to use the DJ name in Business settings, or to say “your DJ”."
      />
      <TextAreaField className="sm:col-span-2" label="Internal notes (staff only, never shown to clients)" name="internal_notes" rows={3} maxLength={20000} defaultValue={event?.internal_notes ?? ""} />
    </div>
  );
}
