import type { HomeTone } from "@/lib/client-home";
import { cn } from "@/lib/utils";

/**
 * Pieces the client's event pages share (/my and each event's hub), on the
 * planning canvas tokens and the business's Brand Ink (set by brandStyle).
 */

/** One sheet on the planning canvas: edge to edge on phones, a rounded sheet from small screens up. */
export const CLIENT_SHEET = "grid min-w-0 content-start gap-4 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6";

export const CLIENT_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-1";

/** The primary action, on Brand Ink (white text stays readable on any brand colour). */
export const CLIENT_PRIMARY = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-5 text-sm font-semibold max-sm:w-full",
  "bg-brand-ink text-white hover:bg-[color-mix(in_oklab,var(--brand-ink),black_14%)] active:bg-[color-mix(in_oklab,var(--brand-ink),black_22%)]",
  "transition-colors motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2",
);

/** A quieter action beside or instead of the primary one: a hairline outline, Brand Ink focus. */
export const CLIENT_SECONDARY = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-4 text-sm font-medium text-foreground ring-1 ring-plan-hairline hover:bg-plan-track/60 max-sm:w-full",
  "transition-colors motion-reduce:transition-none",
  CLIENT_FOCUS,
);

const TONES: Record<HomeTone, string> = {
  action: "bg-status-attention-tint text-status-attention",
  waiting: "bg-plan-track text-foreground",
  done: "bg-[color-mix(in_oklab,var(--status-done)_14%,white)] text-[color-mix(in_oklab,var(--status-done),black_25%)]",
  neutral: "bg-plan-track text-plan-ink-2",
};

/** An event's status (lib/client-home homeCard), the same pill on /my and the hub. */
export function EventStatusPill({ label, tone }: { label: string; tone: HomeTone }) {
  return (
    <span data-testid="event-status" className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold", TONES[tone])}>
      {label}
    </span>
  );
}
