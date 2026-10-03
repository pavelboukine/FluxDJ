import { optionalText, text } from "@/lib/forms";

export const EVENT_TYPES = [
  ["wedding", "Wedding"],
  ["corporate", "Corporate"],
  ["private_party", "Private party"],
  ["school", "School"],
  ["other", "Other"],
] as const;

export function readEventForm(form: FormData) {
  const title = text(form, "title");
  const eventType = text(form, "event_type");
  const eventDate = text(form, "event_date");
  const timezone = text(form, "timezone");
  if (title.length < 1 || title.length > 200) return { ok: false, error: "Title is required." } as const;
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(eventType)) return { ok: false, error: "Choose an event type." } as const;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { ok: false, error: "Choose the event date." } as const;
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone)) return { ok: false, error: "Enter an IANA timezone such as America/Toronto." } as const;
  return {
    ok: true,
    values: {
      title,
      event_type: eventType,
      event_date: eventDate,
      timezone,
      venue_name: optionalText(form, "venue_name"),
      venue_address: optionalText(form, "venue_address"),
      internal_notes: optionalText(form, "internal_notes"),
    },
  } as const;
}
