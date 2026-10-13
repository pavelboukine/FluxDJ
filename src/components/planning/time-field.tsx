"use client";

import { Input } from "@/components/ui/input";
import { nextDayLabel, offersNextDay } from "@/lib/planning/stages";
import { FieldBox, describedBy } from "./basics-editor";

/**
 * A planning time: local to the event ("HH:MM"), with its explicit "Next day"
 * mark (stored as its own answer; the run sheet orders times with it). The
 * mark is only offered where it can matter (see offersNextDay), so ordinary
 * daytime and evening times are a single time picker; a saved next-day time
 * always shows it.
 */
export function TimeField({ id, label, time, nextDay, onTime, onNextDay, eventDate, error, hint, suggestNextDay, className }: {
  id: string;
  label: string;
  time: string;
  nextDay: boolean;
  onTime: (time: string) => void;
  onNextDay: (nextDay: boolean) => void;
  eventDate: string;
  error: string | null;
  hint?: string;
  /** Offer the mark even for a later time: an end that isn't after its start. */
  suggestNextDay?: boolean;
  className?: string;
}) {
  const next = nextDayLabel(eventDate);
  const offered = offersNextDay(time, nextDay, { suggest: suggestNextDay, error: Boolean(error) });
  return (
    <FieldBox id={id} label={label} error={error} hint={hint} className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Input id={id} type="time" className="w-36" value={time} onChange={(e) => onTime(e.target.value)}
          aria-invalid={Boolean(error)} aria-describedby={describedBy(id, error, hint)} />
        {offered ? (
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={nextDay} disabled={time === ""} onChange={(e) => onNextDay(e.target.checked)}
              aria-label={`${label.replace(/ \((needed|optional)\)$/, "")}: next day (${next})`} />
            Next day ({next})
          </label>
        ) : null}
      </div>
    </FieldBox>
  );
}
