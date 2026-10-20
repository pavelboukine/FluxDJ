import { Check, Minus } from "lucide-react";
import type { SectionState, SectionStatus } from "@/lib/planning/navigation";
import { cn } from "@/lib/utils";

/**
 * A section's status as a small glyph, always shown next to its words (never alone).
 * Deliberately unlike a form control (no outlined ring, no centre dot): a filled grey disc
 * when not started, a half-filled disc when in progress (a state, not a percentage: the
 * words beside it carry the exact count), a check when complete and a dash when not
 * applicable.
 */
export function StatusGlyph({ status, className }: { status: SectionStatus; className?: string }) {
  return <ProgressGlyph state={status.state} className={className} />;
}

export function ProgressGlyph({ state, className }: { state: SectionState; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  if (state === "complete") {
    return (
      <span aria-hidden className={cn(base, "inline-grid place-items-center rounded-full bg-status-done text-white")}>
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  }
  if (state === "not_applicable") {
    return (
      <span aria-hidden className={cn(base, "inline-grid place-items-center rounded-full bg-plan-track text-plan-ink-2")}>
        <Minus className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn(base, "text-brand-ink")}>
      <circle cx="8" cy="8" r="8" className="fill-plan-track" />
      {/* In progress: the right half, always the same. */}
      {state === "in_progress" ? <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" /> : null}
    </svg>
  );
}
