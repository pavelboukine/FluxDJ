"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import NextLink, { useLinkStatus } from "next/link";
import { confirmLeavingUnsaved } from "./unsaved-navigation";

/*
 * Navigation feedback for the staff shell. Links from here are ordinary
 * next/link Links (same prefetching and navigation) that also report, through
 * useLinkStatus, while their navigation is pending. The AppShell header shows
 * a thin indeterminate line while any is, after a short delay so fast
 * navigations never flash it. Next.js clears a link's pending state when its
 * navigation completes, fails or is superseded, and an unmounted link stops
 * reporting, so the line can't stay on.
 */

type Report = { start: () => void; end: () => void };
const ReportContext = createContext<Report | null>(null);
const PendingContext = createContext(false);

export function NavigationPendingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const start = useCallback(() => setCount((n) => n + 1), []);
  const end = useCallback(() => setCount((n) => Math.max(0, n - 1)), []);
  const report = useMemo(() => ({ start, end }), [start, end]);
  return (
    <ReportContext.Provider value={report}>
      <PendingContext.Provider value={count > 0}>{children}</PendingContext.Provider>
    </ReportContext.Provider>
  );
}

/** Rendered inside a Link (useLinkStatus requires it); renders nothing. */
function ReportPending() {
  const { pending } = useLinkStatus();
  const report = useContext(ReportContext);
  useEffect(() => {
    if (!pending || !report) return;
    report.start();
    return report.end;
  }, [pending, report]);
  return null;
}

/** A drop-in next/link Link whose pending navigation shows the shell's progress line and honours an unsaved-changes guard. */
export default function Link({ children, onNavigate, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink
      {...props}
      onNavigate={(event) => {
        if (!confirmLeavingUnsaved(typeof props.href === "string" ? props.href : undefined)) event.preventDefault();
        else onNavigate?.(event);
      }}
    >
      <ReportPending />
      {children}
    </NextLink>
  );
}

/**
 * The header's progress line: no layout space (absolutely placed on the
 * header's bottom border), hidden from assistive technology, visible only
 * after 150 ms of pending navigation. Reduced motion: a still line.
 */
export function NavigationProgress() {
  const pending = useContext(PendingContext);
  return (
    <div
      aria-hidden
      data-testid="navigation-progress"
      data-pending={pending ? "" : undefined}
      className="group pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden opacity-0 transition-opacity duration-150 data-pending:opacity-100 data-pending:delay-150"
    >
      <div className="h-full w-1/3 bg-foreground/70 motion-safe:group-data-pending:animate-nav-progress motion-reduce:w-full motion-reduce:bg-foreground/40" />
    </div>
  );
}
