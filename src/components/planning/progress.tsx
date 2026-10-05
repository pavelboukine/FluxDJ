"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { BASICS_REQUIREMENT_LABELS } from "@/lib/planning/basics";
import { basicsProgress, progressHeadline, progressScopeNote, type PlanProgress, type Requirement } from "@/lib/planning/view";

/**
 * Planning progress as computed by the database. The page renders the
 * server's value; each successful save returns the new value, which replaces
 * it here. Nothing is computed from the form in the browser.
 */
const ProgressContext = createContext<{ progress: PlanProgress; setProgress: (p: PlanProgress) => void } | null>(null);

export function PlanProgressProvider({ initial, children }: { initial: PlanProgress; children: ReactNode }) {
  const [progress, setProgress] = useState(initial);
  return <ProgressContext.Provider value={{ progress, setProgress }}>{children}</ProgressContext.Provider>;
}

export function usePlanProgress() {
  return useContext(ProgressContext);
}

export function ProgressSummary() {
  const ctx = usePlanProgress();
  if (!ctx) return null;
  const p = ctx.progress;
  const percent = p.percent ?? 0;
  return (
    <section aria-labelledby="progress-heading" className="grid gap-2 rounded-xl border p-4">
      <h2 id="progress-heading" className="text-sm font-semibold">Progress</h2>
      <p className="text-lg font-medium" data-testid="progress-headline">{progressHeadline(p)}</p>
      {p.requirements_total > 0 ? (
        <div
          role="progressbar"
          aria-label="Required answers in available sections"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-[var(--brand,#059669)]" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{progressScopeNote(p)}</p>
    </section>
  );
}

const STATE_TEXT: Record<Requirement["state"], (dj: string, audience: "client" | "staff") => string> = {
  answered: () => "Answered",
  imported: (dj, audience) => (audience === "client" ? `Provided by ${dj}` : "From the event details"),
  not_applicable: (_, audience) => (audience === "client" ? "Not needed (you said so)" : "Marked not needed"),
  unanswered: () => "Not answered yet",
};

/** What Event basics still needs, from the server's progress. */
export function BasicsChecklist({ djName, audience }: { djName: string; audience: "client" | "staff" }) {
  const ctx = usePlanProgress();
  const item = ctx ? basicsProgress(ctx.progress) : null;
  if (!item) return null;
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">
        {item.met === item.total ? "Event basics is complete." : `${item.met} of ${item.total} needed answers`}
      </p>
      <ul aria-label="What Event basics needs" className="grid gap-0.5">
        {item.requirements.map((r) => (
          <li key={r.key} className="flex flex-wrap justify-between gap-2">
            <span>{BASICS_REQUIREMENT_LABELS[r.key] ?? r.key}</span>
            <span className={r.state === "unanswered" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
              {STATE_TEXT[r.state](djName, audience)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
