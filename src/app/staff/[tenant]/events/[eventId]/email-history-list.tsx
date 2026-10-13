"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type EmailHistoryItem = { id: string; attention: boolean; node: ReactNode };

/** How many of the newest emails show before "Show all". */
export const EMAILS_SHOWN = 3;

/**
 * The event's emails, newest first: the latest few, then "Show all emails
 * (n)" to see the rest in place (and "Show fewer" to fold them again). An
 * older email that needs attention is never folded away: while collapsed it
 * is listed under its own heading below the latest ones.
 */
export function EmailHistoryList({ items, note }: { items: EmailHistoryItem[]; note?: string | null }) {
  const id = useId();
  const [all, setAll] = useState(false);
  const latest = all ? items : items.slice(0, EMAILS_SHOWN);
  const olderAttention = all ? [] : items.slice(EMAILS_SHOWN).filter((i) => i.attention);
  const foldable = items.length > EMAILS_SHOWN;
  const list = "divide-y rounded-lg border";
  return (
    <div className="grid gap-2">
      <ol id={`${id}-list`} className={list} data-testid="communications">
        {latest.map((i) => <Fragment key={i.id}>{i.node}</Fragment>)}
      </ol>
      {olderAttention.length > 0 ? (
        <section aria-labelledby={`${id}-older`} className="grid gap-1.5" data-testid="communications-older-attention">
          <h3 id={`${id}-older`} className="text-xs font-medium text-muted-foreground">Older emails that need your attention</h3>
          <ol className={list}>{olderAttention.map((i) => <Fragment key={i.id}>{i.node}</Fragment>)}</ol>
        </section>
      ) : null}
      {all && note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {foldable ? (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={`${id}-list`}
          onClick={() => setAll((a) => !a)}
          className="inline-flex min-h-9 items-center gap-1 justify-self-start rounded-md text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {all ? "Show fewer" : `Show all emails (${items.length})`}
          <ChevronDown aria-hidden className={cn("size-4 transition-transform", all && "rotate-180")} />
        </button>
      ) : null}
    </div>
  );
}
