"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { GRAND_ENTRANCE_MOMENTS, grandEntranceOpen, type GrandEntrance } from "@/lib/planning/stages";

/**
 * The Reception entrance's grand entrance decision as its details editor
 * currently holds it, so the grand entrance's moments (Introductions, older
 * Entrance music) appear as soon as the client chooses "Yes" and step aside
 * for "No" or "Not sure yet". The answer itself is saved only by the stage's
 * own autosave; progress still comes from the database.
 */
type Slot = {
  decision: GrandEntrance | null;
  /** Whether those moments already held answers when the page loaded. */
  saved: boolean;
  set: (decision: GrandEntrance | null) => void;
};
const GrandEntranceContext = createContext<Slot | null>(null);

export function GrandEntranceProvider({ state, children }: { state: { decision: GrandEntrance | null; saved: boolean }; children: ReactNode }) {
  const [decision, set] = useState(state.decision);
  return <GrandEntranceContext.Provider value={{ decision, saved: state.saved, set }}>{children}</GrandEntranceContext.Provider>;
}

export function useGrandEntrance() {
  return useContext(GrandEntranceContext);
}

/**
 * A moment of the plan, hidden (never unmounted, so nothing typed is lost)
 * while it belongs to a grand entrance that isn't planned. Everything saved
 * in it is kept.
 */
export function GrandEntranceGate({ momentKey, children }: { momentKey: string; children: ReactNode }) {
  const ctx = useGrandEntrance();
  const hidden = Boolean(ctx) && GRAND_ENTRANCE_MOMENTS.includes(momentKey) && !grandEntranceOpen(ctx!.decision, ctx!.saved);
  return <li hidden={hidden} data-grand-entrance={GRAND_ENTRANCE_MOMENTS.includes(momentKey) ? (hidden ? "hidden" : "shown") : undefined}>{children}</li>;
}
