"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DraftVersionProvider, useDraftEditorState } from "@/components/app/draft-version";
import { cn } from "@/lib/utils";
import { watchHashTargets } from "@/components/app/hash-targets";

/**
 * A labelled section that opens on demand, for edit forms and history.
 *  - Opens when the page's address points at it (#id), on load, when an
 *    in-page link changes the hash and on back/forward, so "Record payment"
 *    style links land on an open form.
 *  - `targets`: ids of elements inside it. The address pointing at one of
 *    them opens it the same way and brings that element into view, so links
 *    to something in a collapsed section still land on it.
 *  - Its content stays mounted while closed, so typed values are kept.
 *  - It can't be collapsed while a form inside has unsaved changes (or a
 *    failed save), and says so on its summary, so edits and errors are never
 *    hidden; a disclosure around one with unsaved changes can't be
 *    collapsed either. Nothing here ever closes it.
 */
export function Disclosure({ id, summary, hint, defaultOpen = false, targets, className, children }: { id: string; summary: string; hint?: ReactNode; defaultOpen?: boolean; targets?: readonly string[]; className?: string; children: ReactNode }) {
  return (
    <DraftVersionProvider version={0}>
      <DisclosureInner id={id} summary={summary} hint={hint} defaultOpen={defaultOpen} targets={targets} className={className}>
        {children}
      </DisclosureInner>
    </DraftVersionProvider>
  );
}

function DisclosureInner({ id, summary, hint, defaultOpen, targets, className, children }: { id: string; summary: string; hint?: ReactNode; defaultOpen: boolean; targets?: readonly string[]; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  // A target inside to bring into view once the open content has rendered.
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  const ref = useRef<HTMLDetailsElement>(null);
  // A stable dependency for the listeners (callers usually pass a new array each render).
  const targetKey = (targets ?? []).join(" ");

  useEffect(() => {
    const ids = [id, ...(targetKey ? targetKey.split(" ") : [])];
    return watchHashTargets(window, ids, (match, source) => {
      setOpen(true);
      if (match !== id) {
        setReveal({ id: match });
      } else if (source === "address") {
        // After the browser's own jump, so the opened content is in view.
        window.requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
      }
    });
  }, [id, targetKey]);

  useEffect(() => {
    if (!reveal) return;
    // Runs after the open content is committed; a browser can't jump into closed content by itself.
    const frame = window.requestAnimationFrame(() => document.getElementById(reveal.id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [reveal]);

  return (
    <details
      ref={ref}
      id={id}
      open={open || unsaved}
      data-unsaved={unsaved ? "" : undefined}
      onToggle={(e) => {
        // A nested disclosure's toggle reaches this handler too; only this one's own state matters here.
        if (e.target !== e.currentTarget) return;
        const details = e.currentTarget as HTMLDetailsElement;
        // Never collapse over unsaved edits, here or in a disclosure inside: the browser closed it, so reopen.
        if (!details.open && (unsaved || details.querySelector("details[data-unsaved]"))) {
          details.open = true;
          return;
        }
        setOpen(details.open);
      }}
      className={cn("group/disclosure min-w-0 scroll-mt-20 rounded-lg border", className)}
    >
      <summary className="flex min-h-11 scroll-mt-20 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none select-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", (open || unsaved) && "rotate-90")} />
        {/*
          The label never shrinks below its own words (it wraps at most); the hint gives way first and is cut short.
          The disclosure itself may shrink (min-w-0), so a long one-line hint never widens a grid or flex parent.
        */}
        <span className="grow break-words">{summary}</span>
        {unsaved ? (
          <span className="shrink-0 text-xs font-normal text-amber-700 dark:text-amber-400">Unsaved changes</span>
        ) : hint ? (
          <span className="min-w-0 shrink-[100] truncate text-right text-xs font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </summary>
      <div className="border-t px-3 pt-3 pb-3">{children}</div>
    </details>
  );
}
