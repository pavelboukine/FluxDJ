"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DraftVersionProvider, useDraftEditorState } from "@/components/app/draft-version";
import { cn } from "@/lib/utils";

/**
 * A labelled section that opens on demand, for edit forms and history.
 *  - Opens when the page's address points at it (#id), on load and when an
 *    in-page link changes the hash, so "Record payment" style links land on
 *    an open form.
 *  - Its content stays mounted while closed, so typed values are kept.
 *  - It can't be collapsed while a form inside has unsaved changes (or a
 *    failed save), and says so on its summary, so edits and errors are never
 *    hidden.
 */
export function Disclosure({ id, summary, hint, defaultOpen = false, className, children }: { id: string; summary: string; hint?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  return (
    <DraftVersionProvider version={0}>
      <DisclosureInner id={id} summary={summary} hint={hint} defaultOpen={defaultOpen} className={className}>
        {children}
      </DisclosureInner>
    </DraftVersionProvider>
  );
}

function DisclosureInner({ id, summary, hint, defaultOpen, className, children }: { id: string; summary: string; hint?: ReactNode; defaultOpen: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const sync = () => {
      if (window.location.hash === `#${id}`) {
        setOpen(true);
        // After the browser's own jump, so the opened content is in view.
        window.requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
      }
    };
    // A link to this section opens it even when the address already points here
    // (no hashchange) or when a client-side router set the hash without one.
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (link && new URL((link as HTMLAnchorElement).href, window.location.href).hash === `#${id}` && (link as HTMLAnchorElement).pathname === window.location.pathname) {
        setOpen(true);
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.removeEventListener("click", onClick);
    };
  }, [id]);

  return (
    <details
      ref={ref}
      id={id}
      open={open || unsaved}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        // Never collapse over unsaved edits: the browser closed it, so reopen.
        if (!next && unsaved) {
          (e.currentTarget as HTMLDetailsElement).open = true;
          return;
        }
        setOpen(next);
      }}
      className={cn("group/disclosure scroll-mt-20 rounded-lg border", className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none select-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-90" />
        <span className="min-w-0 flex-1">{summary}</span>
        {unsaved ? <span className="text-xs font-normal text-amber-700 dark:text-amber-400">Unsaved changes</span> : hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="border-t px-3 pt-3 pb-3">{children}</div>
    </details>
  );
}
