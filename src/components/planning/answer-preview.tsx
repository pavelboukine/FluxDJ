"use client";

import { createContext, useCallback, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { answerSummary, type SummaryContext } from "@/lib/planning/summaries";

/**
 * Live answer previews for collapsed questions and the overview. Each
 * mounted editor reports the answers its current form would save (what its
 * own parser makes of it, typed but maybe not saved yet); readers format
 * them with answerSummary. Display only: nothing here saves, validates or
 * changes an answer, and whether a change is saved is the save registry's
 * job (rows show "Saving…" or "Not saved" next to a preview that isn't).
 * Editors stay mounted when a question collapses or the section changes, so
 * a pending or failed draft keeps its preview.
 */

type Answers = Record<string, unknown>;

class PreviewStore {
  private answers: Map<string, Answers>;
  constructor(initial: Record<string, Answers>) {
    this.answers = new Map(Object.entries(initial));
  }
  private listeners = new Map<string, Set<() => void>>();
  subscribe = (item: string, listener: () => void) => {
    const set = this.listeners.get(item) ?? new Set();
    set.add(listener);
    this.listeners.set(item, set);
    return () => set.delete(listener);
  };
  get(item: string): Answers | undefined {
    return this.answers.get(item);
  }
  set(item: string, answers: Answers) {
    if (this.answers.get(item) === answers) return;
    this.answers.set(item, answers);
    for (const l of this.listeners.get(item) ?? []) l();
  }
}

const StoreContext = createContext<PreviewStore | null>(null);
const SummaryContextValue = createContext<SummaryContext | null>(null);

/**
 * Planning pages (client and staff) wrap their editors in this; without it, previews are simply
 * absent. `saved` holds the answers the page loaded (item id to answers), so previews show in the
 * first render; each editor then reports its own form, which starts from the same answers.
 */
export function AnswerPreviewProvider({ context, saved, children }: { context: SummaryContext; saved: Record<string, Answers>; children: ReactNode }) {
  const [store] = useState(() => new PreviewStore(saved));
  return (
    <StoreContext.Provider value={store}>
      <SummaryContextValue.Provider value={context}>{children}</SummaryContextValue.Provider>
    </StoreContext.Provider>
  );
}

/** For useAutosave: reports an item's current answers (the parsed form); a no-op without a provider. */
export function usePreviewPublisher(): (item: string, answers: Answers) => void {
  const store = useContext(StoreContext);
  return useCallback((item: string, answers: Answers) => store?.set(item, answers), [store]);
}

/** The item's current answers as reported by its editor, or undefined before it has reported. */
export function useLiveAnswers(item: string): Answers | undefined {
  const store = useContext(StoreContext);
  const subscribe = useCallback((l: () => void) => (store ? store.subscribe(item, l) : () => {}), [store, item]);
  return useSyncExternalStore(subscribe, () => store?.get(item), () => undefined);
}

/** The one-line preview of an item's current answers (null when there is nothing to show). */
export function useAnswerSummary(item: string, editor: string | null | undefined): string | null {
  const answers = useLiveAnswers(item);
  const ctx = useContext(SummaryContextValue);
  return ctx ? answerSummary(editor, answers, ctx) : null;
}
