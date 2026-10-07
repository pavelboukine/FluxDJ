import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { shortDate } from "@/lib/dates";
import { eventStatusLabel } from "@/lib/events/status";
import { nearDay } from "@/lib/lists";
import { cn } from "@/lib/utils";

/** The lifecycle badge of the event lists, with "Booked" in green. */
export function EventStatusBadge({ status, contractSigned }: { status: string; contractSigned: boolean }) {
  return (
    <Badge variant="outline" className={cn("h-auto whitespace-normal", status === "booked" ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null)}>
      {eventStatusLabel(status, contractSigned)}
    </Badge>
  );
}

/**
 * One event in a staff list (the Events list, a client's events): the
 * calendar date with Today/Tomorrow/Yesterday in the event's own time zone,
 * the linked title, a detail line and the archived and status badges.
 */
export function EventRow({
  href,
  title,
  eventDate,
  today,
  details,
  status,
  contractSigned,
  archived,
}: {
  href: string;
  title: string;
  eventDate: string;
  /** Today's date in the event's time zone. */
  today: string;
  details: ReactNode;
  status: string;
  contractSigned: boolean;
  archived: boolean;
}) {
  const near = nearDay(eventDate, today);
  return (
    <li data-testid="event-row">
      <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:items-center">
        <span className="flex items-baseline gap-2 sm:grid sm:gap-0">
          <span className="font-medium whitespace-nowrap">{shortDate(eventDate)}</span>
          {near ? <span className="text-xs text-muted-foreground">{near}</span> : null}
        </span>
        <span className="grid min-w-0">
          <Link className="truncate font-medium underline-offset-4 hover:underline" href={href}>{title}</Link>
          <span className="truncate text-muted-foreground">{details}</span>
        </span>
        <span className="flex flex-wrap gap-1 sm:justify-end">
          {archived ? <Badge variant="secondary">Archived</Badge> : null}
          <EventStatusBadge status={status} contractSigned={contractSigned} />
        </span>
      </div>
    </li>
  );
}
