"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SaveState } from "./use-autosave";

/**
 * Where each mounted editor's autosave stands, for the client's section
 * navigation. Editors are never unmounted when the client switches section
 * (inactive sections are only hidden), so pending, failed and debounced
 * saves keep their input; this registry only reports their state so the
 * navigation can say where something isn't saved, send a debounced save
 * right away when the client leaves a section, and warn before the browser
 * leaves the page with unsaved input. Answers never pass through here.
 *
 * Without a provider (the staff page) every hook is a no-op.
 */

type Entry = { section: string | null; item: string | null; state: SaveState; flush: () => void };
export type SaveSummary = "saved" | "pending" | "not_saved";

/** States whose input never reached the database. */
const NOT_SAVED: SaveState[] = ["error", "invalid", "signed_out", "conflict", "locked", "unavailable"];
/** States worth a browser-leave warning: the input can still be saved from this page. */
const LEAVE_WARNING: SaveState[] = ["unsaved", "saving", "error", "invalid", "signed_out"];

class SaveStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit() {
    for (const l of this.listeners) l();
  }
  set(id: string, entry: Entry) {
    const old = this.entries.get(id);
    this.entries.set(id, entry);
    if (old?.state !== entry.state || old.section !== entry.section) this.emit();
  }
  remove(id: string) {
    if (this.entries.delete(id)) this.emit();
  }
  summary(match: (e: Entry) => boolean): SaveSummary {
    let pending = false;
    for (const e of this.entries.values()) {
      if (!match(e)) continue;
      if (NOT_SAVED.includes(e.state)) return "not_saved";
      if (e.state === "unsaved" || e.state === "saving") pending = true;
    }
    return pending ? "pending" : "saved";
  }
  /** Sections with input that wasn't saved, joined (a stable snapshot value). */
  notSavedSections(): string {
    const keys = new Set<string>();
    for (const e of this.entries.values()) if (e.section !== null && NOT_SAVED.includes(e.state)) keys.add(e.section);
    return [...keys].join(" ");
  }
  needsLeaveWarning(): boolean {
    for (const e of this.entries.values()) if (LEAVE_WARNING.includes(e.state)) return true;
    return false;
  }
  /** Sends the section's debounced saves now (a save already running or failed is left as it is). */
  flush(section: string | null) {
    for (const e of this.entries.values()) if (e.section === section) e.flush();
  }
}

const StoreContext = createContext<SaveStore | null>(null);
const ScopeContext = createContext<{ section: string | null; item: string | null }>({ section: null, item: null });

export function SaveRegistryProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SaveStore());
  return (
    <StoreContext.Provider value={store}>
      {children}
      <LeaveWarning store={store} />
    </StoreContext.Provider>
  );
}

/** Names the section (and optionally the item) the editors inside belong to. */
export function SaveScope({ section, item, children }: { section?: string | null; item?: string | null; children: ReactNode }) {
  const parent = useContext(ScopeContext);
  const value = { section: section === undefined ? parent.section : section, item: item === undefined ? parent.item : item };
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useSaveStore() {
  return useContext(StoreContext);
}

/** Called by useAutosave: reports its state and how to send a debounced save now. */
export function useRegisterSave(state: SaveState, flush: () => void) {
  const store = useContext(StoreContext);
  const scope = useContext(ScopeContext);
  const id = useId();
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => {
    store?.set(id, { section: scope.section, item: scope.item, state, flush: () => flushRef.current() });
  }, [store, id, scope.section, scope.item, state]);
  useEffect(() => () => store?.remove(id), [store, id]);
}

const noop = () => () => {};

export function useSectionSaveSummary(section: string | null): SaveSummary {
  const store = useContext(StoreContext);
  return useSyncExternalStore(store?.subscribe ?? noop, () => store?.summary((e) => e.section === section) ?? "saved", () => "saved");
}

export function useItemSaveSummary(item: string): SaveSummary {
  const store = useContext(StoreContext);
  return useSyncExternalStore(store?.subscribe ?? noop, () => store?.summary((e) => e.item === item) ?? "saved", () => "saved");
}

export function useNotSavedSections(): string[] {
  const store = useContext(StoreContext);
  const joined = useSyncExternalStore(store?.subscribe ?? noop, () => store?.notSavedSections() ?? "", () => "");
  return joined ? joined.split(" ") : [];
}

/** The browser's own "leave page?" prompt while input could still be saved here. */
function LeaveWarning({ store }: { store: SaveStore }) {
  const warn = useSyncExternalStore(store.subscribe, () => store.needsLeaveWarning(), () => false);
  useEffect(() => {
    if (!warn) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [warn]);
  return null;
}
