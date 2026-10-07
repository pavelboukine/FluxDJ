/**
 * Dates as staff read them. Event dates are calendar dates (no time and no
 * zone), so they are formatted as UTC calendar days and never shifted by the
 * viewer's or server's time zone. Instants (deadlines, signing times) are
 * shown in the event's own time zone.
 */

/** Today's date (YYYY-MM-DD) in a time zone at an instant. */
export function dateIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const utcDay = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** "Sat, Aug 14, 2027": a calendar date, never shifted by time zones. */
export function shortDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(utcDay(isoDate));
}

/** "Oct 16, 2026, 12:00 a.m. EDT": an instant in a time zone, with the zone's abbreviation. */
export function shortInstant(iso: string, timeZone: string): string {
  // dateStyle can't be combined with timeZoneName, so the fields are spelled out.
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(iso));
}
