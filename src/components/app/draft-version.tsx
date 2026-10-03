"use client";

import { createContext, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";

/**
 * Shared state for the forms on a page that edit the same draft row (the
 * proposal builder's "apply template", "save draft" and "send" controls):
 *  - one optimistic-concurrency version, advanced by each successful save, so
 *    the next action from any of those forms sends the right version without
 *    waiting for a page refresh (a different tab has its own counter and
 *    still gets a conflict);
 *  - whether the editor has unsaved changes, so sending can require a save
 *    and applying a template can ask before discarding edits.
 */
type DraftEditorState = {
  version: MutableRefObject<number>;
  unsaved: boolean;
  setUnsaved: (value: boolean) => void;
};

const DraftVersionContext = createContext<DraftEditorState | null>(null);

export function DraftVersionProvider({ version, children }: { version: number; children: ReactNode }) {
  // Starts at the page's version. Forms combine it with their own (possibly
  // newer) page value, so a later server render can never move it backwards.
  const latest = useRef(version);
  const [unsaved, setUnsaved] = useState(false);
  const value = useMemo(() => ({ version: latest, unsaved, setUnsaved }), [unsaved]);
  return <DraftVersionContext.Provider value={value}>{children}</DraftVersionContext.Provider>;
}

export function useSharedDraftVersion() {
  return useContext(DraftVersionContext)?.version ?? null;
}

export function useDraftEditorState() {
  return useContext(DraftVersionContext);
}
