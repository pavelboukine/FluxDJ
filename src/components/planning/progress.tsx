"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, Lock } from "lucide-react";
import { BASICS_REQUIREMENT_LABELS, type BasicsAnswers } from "@/lib/planning/basics";
import { clientEditingText, formatInstant, type ClientEditing } from "@/lib/planning/cutoff";
import { REQUIREMENT_NOTES, requirementLabel } from "@/lib/planning/stages";
import type { SectionState } from "@/lib/planning/navigation";
import { ProgressGlyph } from "./status-glyph";
import { cn } from "@/lib/utils";
import { itemProgress, progressHeadline, progressPercent, progressPercentText, progressScopeNote, type PlanProgress, type Requirement, type TimelineWarning } from "@/lib/planning/view";
import type { SaveState } from "./use-autosave";

/**
 * Planning state computed by the database: progress, chronology warnings,
 * the saved Event basics (stage editors reuse its venue, guest count and end
 * time) and, on the client's page, whether the client can still edit. The
 * page renders the server's values; each successful save returns new ones,
 * which replace them here, and so does a server refresh of the page. Nothing
 * is computed from forms.
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

/**
 * The announcement language as Event basics' editor holds it, for DJ
 * expectations to ask it there. The answer stays in Event basics (one
 * answer, one revision, one autosave), so the two sections never save it
 * separately or disagree.
 */
export type LanguageBinding = {
  value: string;
  set: (value: string) => void;
  error: string | null;
  saveState: SaveState;
  message: string | null;
  retry: () => void;
};
type LanguageSlot = { binding: LanguageBinding | null; publish: (binding: LanguageBinding | null) => void };
const LanguageContext = createContext<LanguageSlot | null>(null);

/** Event basics' language, once its editor is ready; null until then or when Event basics asks it itself. */
export function useLanguageBinding(): LanguageBinding | null {
  return useContext(LanguageContext)?.binding ?? null;
}

export function usePublishLanguage(): LanguageSlot["publish"] | null {
  return useContext(LanguageContext)?.publish ?? null;
}

export function PlanProgressProvider({ initial, warnings, basics, editing = null, children }: {
  initial: PlanProgress;
  warnings: TimelineWarning[];
  basics: BasicsAnswers;
  editing?: ClientEditing | null;
  children: ReactNode;
}) {
  const [state, setState] = useState({ progress: initial, warnings, basics, editing });
  // A server refresh (after a structure change or an editing action on the staff page) brings
  // newer values from the database: adopt them. Saves in between update the same state.
  // Compared by content, so re-rendering with the same server data never undoes a save.
  const incoming = JSON.stringify([initial, warnings, basics, editing]);
  const [source, setSource] = useState(incoming);
  if (incoming !== source) {
    setSource(incoming);
    setState({ progress: initial, warnings, basics, editing });
  }
  const value: PlanState = {
    ...state,
    applySaved: (r) => setState((s) => ({ ...s, progress: r.progress, warnings: r.timeline_warnings })),
    setBasics: (b) => setState((s) => ({ ...s, basics: b })),
    applyLocked: (e) => setState((s) => ({ ...s, editing: e })),
  };
  const [language, publishLanguage] = useState<LanguageBinding | null>(null);
  const slot = useMemo(() => ({ binding: language, publish: publishLanguage }), [language]);
  return (
    <PlanContext.Provider value={value}>
      <LanguageContext.Provider value={slot}>{children}</LanguageContext.Provider>
    </PlanContext.Provider>
  );
}

export function usePlanProgress() {
  return useContext(PlanContext);
}

/** Whether an editor is read-only: its own reason (archived, staff), or the client's planning closed. */
export function useEditingClosed(disabledReason?: string): boolean {
  const ctx = useContext(PlanContext);
  return Boolean(disabledReason) || ctx?.editing?.state === "closed";
}

/**
 * The client's deadline or read-only notice, kept current when a save finds planning closed.
 * It sits in the planning header: one quiet line while planning is open, a clear block when
 * it has closed (its text in full ink on the tint, so it keeps its contrast).
 */
export function EditingNotice({ djName }: { djName: string }) {
  const ctx = usePlanProgress();
  const e = ctx?.editing;
  if (!e) return null;
  if (e.state === "closed") {
    return (
      <section
        aria-label="Editing"
        role="alert"
        data-testid="editing-notice"
        data-state={e.state}
        className="flex items-start gap-2.5 rounded-xl bg-status-attention-tint px-3.5 py-3 text-sm text-foreground"
      >
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-status-attention" />
        <span className="grid gap-0.5">
          <span className="font-medium">{clientEditingText(e, djName)}</span>
          <span>
            {e.closed_by_dj ? `${djName} has closed planning to changes.` : `The planning deadline was ${formatInstant(e.deadline, e.timezone)}.`} You can
            still open every section to see what was saved.
          </span>
        </span>
      </section>
    );
  }
  const until = formatInstant(e.closes_at ?? e.deadline, e.timezone);
  return (
    <p aria-label="Editing" role="status" data-testid="editing-notice" data-state={e.state} className="flex items-start gap-2 text-sm text-plan-ink-2">
      <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0" />
      {e.state === "reopened" ? (
        <span className="text-foreground">{clientEditingText(e, djName)}</span>
      ) : (
        <span>
          <span className="text-foreground">You can make changes until {until}.</span> After that, contact {djName} for changes.
        </span>
      )}
    </p>
  );
}

/**
 * "43% complete", the count behind it ("18 of 42 required answers") and the
 * bar: the same numbers on the client's and staff pages (see progressPercent).
 */
export function ProgressMeter({ progress, bar, compact = false }: { progress: PlanProgress; bar: string; compact?: boolean }) {
  const percent = progressPercent(progress);
  const headline = progressHeadline(progress);
  return (
    <div className="grid gap-2">
      {percent === null ? (
        <p className={compact ? "text-sm font-medium" : "text-base font-medium"} data-testid="progress-headline">{headline}</p>
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className={compact ? "text-lg font-semibold tabular-nums" : "text-lg font-semibold tracking-tight tabular-nums"} data-testid="progress-percent">
            {progressPercentText(progress)}
          </span>
          <span className="text-sm text-plan-ink-2 tabular-nums" data-testid="progress-headline">{headline}</span>
        </p>
      )}
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label="Required answers in available sections"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${progressPercentText(progress)}, ${headline}`}
          className="h-1.5 overflow-hidden rounded-full bg-plan-track"
        >
          <div className={cn("h-full rounded-full", bar)} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function ProgressSummary() {
  const ctx = usePlanProgress();
  if (!ctx) return null;
  const p = ctx.progress;
  const discuss = p.items.flatMap((i) => i.requirements).filter((r) => r.discuss).length;
  return (
    <section aria-labelledby="progress-heading" className="grid gap-2 rounded-xl border p-4">
      <h2 id="progress-heading" className="text-sm font-semibold">Progress</h2>
      <ProgressMeter progress={p} bar="bg-[var(--brand,#059669)]" />
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

type ItemProgressValue = NonNullable<ReturnType<typeof itemProgress>>;

function requirementText(r: Requirement, item: { key: string }, editor?: string): string {
  const label = (BASICS_REQUIREMENT_LABELS[r.key] && item.key === "basics" ? BASICS_REQUIREMENT_LABELS[r.key] : requirementLabel(r.key, editor)) ?? r.key;
  // A note says why it's still open ("No event venue yet"). The language is asked in DJ expectations, so its note doesn't apply there.
  const note = r.state === "unanswered" && r.note && r.key !== "language" ? REQUIREMENT_NOTES[r.note] : undefined;
  return note ? `${label} (${note})` : label;
}

/**
 * What one item still needs, from the server's progress, in one or two short lines:
 * "Still needed: Guest arrival time, Start time" and "To discuss with your DJ:
 * Microphone needs". Nothing once the item is complete: its status says so.
 * When planning is closed, open answers are named without asking for them.
 */
export function ItemChecklist({ itemId, title, djName, audience, editor }: { itemId: string; title: string; djName: string; audience: "client" | "staff"; editor?: string }) {
  const ctx = usePlanProgress();
  const item = ctx ? itemProgress(ctx.progress, itemId) : null;
  if (!item || item.total === 0 || item.met === item.total) return null;
  const closed = ctx?.editing?.state === "closed";
  const discuss = item.requirements.filter((r) => r.discuss).map((r) => requirementText(r, item, editor));
  const needed = item.requirements.filter((r) => !r.discuss && r.state === "unanswered").map((r) => requirementText(r, item, editor));
  void djName;
  return (
    <div className="grid gap-0.5 text-sm text-plan-ink-2" data-testid="item-needs" aria-label={`What ${title} still needs`} role="group">
      {needed.length > 0 ? (
        <p>
          <span className="font-medium text-foreground">{closed ? "Not answered:" : "Still needed:"}</span> {needed.join(", ")}
        </p>
      ) : null}
      {discuss.length > 0 ? (
        <p>
          <span className="font-medium text-foreground">{audience === "client" ? "To discuss with your DJ:" : "To discuss with the client:"}</span> {discuss.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** An item's state as a glyph state (all requirements "not needed" reads as not applicable). */
export function itemGlyphState(item: ItemProgressValue | null): SectionState {
  if (!item) return "nothing";
  if (item.state === "complete") return item.requirements.length > 0 && item.requirements.every((r) => r.state === "not_applicable") ? "not_applicable" : "complete";
  if (item.state === "not_available") return "nothing";
  return item.state;
}

/** The words for an item's state; when planning is closed, "Not started" reads as "Not answered". */
export function itemStatusText(item: ItemProgressValue, closed = false): string {
  const glyph = itemGlyphState(item);
  if (glyph === "not_applicable") return "Not applicable";
  return { complete: "Complete", in_progress: "In progress", not_started: closed ? "Not answered" : "Not started", not_available: "Not available yet" }[item.state];
}

/** A stage's details status: glyph and words (never a badge). */
export function ItemStatus({ itemId }: { itemId: string }) {
  const ctx = usePlanProgress();
  const item = ctx ? itemProgress(ctx.progress, itemId) : null;
  if (!item) return null;
  const warned = ctx!.warnings.some((w) => w.item_id === itemId);
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-sm text-plan-ink-2">
      {warned ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-status-attention-tint px-2 py-0.5 text-xs font-medium text-status-attention">Check timing</span>
      ) : null}
      <ProgressGlyph state={itemGlyphState(item)} />
      <span>{itemStatusText(item, ctx!.editing?.state === "closed")}</span>
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
