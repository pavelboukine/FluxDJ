"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { BASICS_REQUIREMENT_LABELS, type BasicsAnswers } from "@/lib/planning/basics";
import { clientEditingText, formatInstant, type ClientEditing } from "@/lib/planning/cutoff";
import { REQUIREMENT_NOTES, STAGE_REQUIREMENT_LABELS } from "@/lib/planning/stages";
import { itemProgress, progressHeadline, progressScopeNote, type PlanProgress, type Requirement, type TimelineWarning } from "@/lib/planning/view";

/**
 * Planning state computed by the database: progress, chronology warnings,
 * the saved Event basics (stage editors reuse its venue, guest count and end
 * time) and, on the client's page, whether the client can still edit. The
 * page renders the server's values; each successful save returns new ones,
 * which replace them here. Nothing is computed from forms.
 *
 * Editing is one shared state for every editor: when any save comes back
 * "locked" (the deadline passed while the page was open), every editor turns
 * read-only at once and stops sending, keeping what is on screen.
 */
type PlanState = {
  progress: PlanProgress;
  warnings: TimelineWarning[];
  basics: BasicsAnswers;
  /** The client's editing state; null on staff pages (staff edit after the deadline). */
  editing: ClientEditing | null;
  applySaved: (result: { progress: PlanProgress; timeline_warnings: TimelineWarning[] }) => void;
  setBasics: (answers: BasicsAnswers) => void;
  applyLocked: (editing: ClientEditing) => void;
};

const PlanContext = createContext<PlanState | null>(null);

export function PlanProgressProvider({ initial, warnings, basics, editing = null, children }: {
  initial: PlanProgress;
  warnings: TimelineWarning[];
  basics: BasicsAnswers;
  editing?: ClientEditing | null;
  children: ReactNode;
}) {
  const [state, setState] = useState({ progress: initial, warnings, basics, editing });
  const value: PlanState = {
    ...state,
    applySaved: (r) => setState((s) => ({ ...s, progress: r.progress, warnings: r.timeline_warnings })),
    setBasics: (b) => setState((s) => ({ ...s, basics: b })),
    applyLocked: (e) => setState((s) => ({ ...s, editing: e })),
  };
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlanProgress() {
  return useContext(PlanContext);
}

/** Whether an editor is read-only: its own reason (archived, staff), or the client's planning closed. */
export function useEditingClosed(disabledReason?: string): boolean {
  const ctx = useContext(PlanContext);
  return Boolean(disabledReason) || ctx?.editing?.state === "closed";
}

/** The client's deadline or read-only notice, kept current when a save finds planning closed. */
export function EditingNotice({ djName }: { djName: string }) {
  const ctx = usePlanProgress();
  const e = ctx?.editing;
  if (!e) return null;
  const closed = e.state === "closed";
  return (
    <section
      aria-label="Editing"
      role={closed ? "alert" : "status"}
      data-testid="editing-notice"
      data-state={e.state}
      className={closed ? "grid gap-1 rounded-xl border border-amber-500/60 bg-amber-500/10 p-4 text-sm" : "grid gap-1 rounded-xl border bg-card p-4 text-sm"}
    >
      <p className={closed ? "font-medium" : undefined}>{clientEditingText(e, djName)}</p>
      {closed ? (
        <p className="text-muted-foreground">
          The planning deadline was {formatInstant(e.deadline, e.timezone)}. You can still open every section to see what was saved.
        </p>
      ) : null}
    </section>
  );
}

export function ProgressSummary() {
  const ctx = usePlanProgress();
  if (!ctx) return null;
  const p = ctx.progress;
  const percent = p.percent ?? 0;
  const discuss = p.items.flatMap((i) => i.requirements).filter((r) => r.discuss).length;
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
      {discuss > 0 ? <p className="text-sm">{discuss === 1 ? "1 detail is" : `${discuss} details are`} marked &quot;discuss with DJ&quot; and still open.</p> : null}
      {ctx.warnings.length > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="timing-summary">
          {ctx.warnings.length === 1 ? "1 timing note to check" : `${ctx.warnings.length} timing notes to check`} (see the stages below).
        </p>
      ) : null}
    </section>
  );
}

function stateText(r: Requirement, dj: string, audience: "client" | "staff"): string {
  if (r.discuss) return audience === "client" ? `Discuss with ${dj} (still open)` : "Discuss with DJ (still open)";
  if (r.state === "unanswered") return r.note ? REQUIREMENT_NOTES[r.note] ?? "Not answered yet" : "Not answered yet";
  if (r.state === "answered") return "Answered";
  if (r.state === "imported") return audience === "client" ? `Provided by ${dj}` : "From the event details";
  return audience === "client" ? "Not needed (you said so)" : "Marked not needed";
}

/** What one item still needs, from the server's progress. */
export function ItemChecklist({ itemId, title, djName, audience }: { itemId: string; title: string; djName: string; audience: "client" | "staff" }) {
  const ctx = usePlanProgress();
  const item = ctx ? itemProgress(ctx.progress, itemId) : null;
  if (!item || item.total === 0) return null;
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">{item.met === item.total ? `${title} is complete.` : `${item.met} of ${item.total} needed answers`}</p>
      <ul aria-label={`What ${title} needs`} className="grid gap-0.5">
        {item.requirements.map((r) => (
          <li key={r.key} className="flex flex-wrap justify-between gap-2">
            <span>{BASICS_REQUIREMENT_LABELS[r.key] && item.key === "basics" ? BASICS_REQUIREMENT_LABELS[r.key] : STAGE_REQUIREMENT_LABELS[r.key] ?? r.key}</span>
            <span className={r.state === "unanswered" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{stateText(r, djName, audience)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A stage card's status badge. */
export function ItemStatus({ itemId }: { itemId: string }) {
  const ctx = usePlanProgress();
  const item = ctx ? itemProgress(ctx.progress, itemId) : null;
  if (!item) return null;
  const warned = ctx!.warnings.some((w) => w.item_id === itemId);
  const label = { complete: "Complete", in_progress: "In progress", not_started: "Not started", not_available: "Not available yet" }[item.state];
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {warned ? <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">Check timing</Badge> : null}
      <Badge variant={item.state === "complete" ? "secondary" : "outline"}>{label}</Badge>
    </span>
  );
}

/** Chronology notes for one stage (the stages are never reordered by time). */
export function ItemWarnings({ itemId }: { itemId: string }) {
  const ctx = usePlanProgress();
  const warnings = ctx?.warnings.filter((w) => w.item_id === itemId) ?? [];
  if (warnings.length === 0) return null;
  return (
    <ul role="status" aria-label="Timing notes" className="grid gap-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      {warnings.map((w) => <li key={w.message}>{w.message}</li>)}
    </ul>
  );
}
