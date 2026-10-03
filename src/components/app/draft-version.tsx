"use client";

import { createContext, useContext, useRef, type MutableRefObject, type ReactNode } from "react";

/**
 * One optimistic-concurrency version shared by every form on a page that
 * edits the same row (the proposal builder's "apply template" and "save
 * draft" forms). Each successful save advances it, so the next save from any
 * of those forms sends the right version without waiting for a page refresh.
 * A different tab has its own counter and still gets a conflict.
 */
const DraftVersionContext = createContext<MutableRefObject<number> | null>(null);

export function DraftVersionProvider({ version, children }: { version: number; children: ReactNode }) {
  // Starts at the page's version. Forms combine it with their own (possibly
  // newer) page value, so a later server render can never move it backwards.
  const latest = useRef(version);
  return <DraftVersionContext.Provider value={latest}>{children}</DraftVersionContext.Provider>;
}

export function useSharedDraftVersion() {
  return useContext(DraftVersionContext);
}
