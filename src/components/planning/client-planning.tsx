"use client";

import { ChevronRight, Lock } from "lucide-react";
import { PROVIDED_SECTION, firstIncompleteSection, isIncomplete, sectionStatus, type PlanSection, type SectionStatus } from "@/lib/planning/navigation";
import { cn } from "@/lib/utils";
import { useAnswerSummary } from "./answer-preview";
import { ProgressMeter, usePlanProgress } from "./progress";
import { Flags, NavLink, PLAN_FOCUS, PLAN_PRIMARY, PanelHeading, StatusGlyph, focusFor, statusText, useNav } from "./plan-navigation";

/** The client's planning overview and editing chip (navigation itself is shared: plan-navigation). */

// ---------------------------------------------------------------------------
// Editing chip
// ---------------------------------------------------------------------------

/** Whether the client can edit now; follows a save that finds planning closed. */
export function EditingChip() {
  const e = usePlanProgress()?.editing;
  if (!e) return null;
  return (
    <span data-testid="editing-chip" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-plan-surface px-2.5 py-1 text-xs font-medium ring-1 ring-plan-hairline">
      {e.state === "closed" ? (
        <Lock aria-hidden className="size-3 text-plan-ink-2" />
      ) : (
        <span aria-hidden className={cn("size-1.5 rounded-full", e.state === "open" ? "bg-status-done" : "bg-status-attention")} />
      )}
      {e.state === "open" ? "Planning open" : e.state === "reopened" ? "Reopened" : "Read-only"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** A sheet on the planning canvas (no pager inside, so it keeps its bottom padding). */
export const OVERVIEW_SHEET = "grid min-w-0 grid-cols-1 gap-5 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6";

type Row = { s: PlanSection; status: SectionStatus };

export function PlanOverview({ djName, providedCount }: { djName: string; providedCount: number }) {
  const nav = useNav();
  const plan = usePlanProgress();
  if (!plan) return null;
  const p = plan.progress;
  const closed = plan.editing?.state === "closed";
  const next = firstIncompleteSection(nav.sections, p, plan.warnings);
  const first = nav.sections[0] ?? null;
  const rows: Row[] = nav.sections.map((s) => ({ s, status: sectionStatus(s, p, plan.warnings) }));
  // Sections, as the client sees them (the database's own counts are per question).
  const counted = rows.filter(({ status }) => status.state !== "nothing");
  const done = counted.filter(({ status }) => status.state === "complete" || status.state === "not_applicable").length;
  // Only what needs action: a timing note or an answer left to discuss. Unanswered questions are normal, not a problem.
  const attention = rows.filter(({ status }) => status.discuss > 0 || status.warnings > 0);
  const general = rows.filter(({ s }) => s.kind === "general");
  const stages = rows.filter(({ s }) => s.kind === "stage");
  const button = cn(
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-5 text-sm font-semibold max-sm:w-full",
    PLAN_PRIMARY,
    PLAN_FOCUS,
  );

  return (
    <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      <div className="grid gap-4 sm:gap-6 lg:sticky lg:top-6">
        <section aria-labelledby="plan-heading-overview" className={OVERVIEW_SHEET}>
          <div className="grid gap-3">
            <PanelHeading view={null}>Planning progress</PanelHeading>
            <ProgressMeter progress={p} bar="bg-brand-ink" />
            <p className="max-w-[65ch] text-sm text-pretty text-plan-ink-2">
              {counted.length > 0 ? `${done} of ${counted.length} ${counted.length === 1 ? "section" : "sections"} complete. ` : null}
              {p.unavailable_sections > 0 ? "Some parts open later and aren't counted yet. " : null}
              Progress shows what you&apos;ve filled in; it doesn&apos;t mean {djName} has reviewed or approved your plan.
            </p>
          </div>
          {first ? (
            closed ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <NavLink view={first.key} className={button} data-testid="plan-primary">View planning</NavLink>
                <p className="text-sm text-plan-ink-2">Everything stays visible; changes now go through {djName}.</p>
              </div>
            ) : next ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <NavLink view={next.key} focusItem={focusFor(next, sectionStatus(next, p, plan.warnings))} className={button} data-testid="plan-primary">
                  Continue planning
                </NavLink>
                <p className="text-sm text-plan-ink-2">Next up: <span className="font-medium text-foreground">{next.label}</span></p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <NavLink view={first.key} className={button} data-testid="plan-primary">Review your plan</NavLink>
                <p className="text-sm text-plan-ink-2">Every required answer in the available sections is in. You can still review and change them.</p>
              </div>
            )
          ) : null}

          {attention.length > 0 ? (
            <div className="grid gap-2 border-t border-plan-hairline pt-4">
              <h3 id="plan-attention-heading" className="text-sm font-semibold">Needs your attention</h3>
              <ul className="grid" aria-labelledby="plan-attention-heading" data-testid="plan-open">
                {attention.map(({ s, status }) => (
                  <li key={s.key}>
                    <NavLink
                      view={s.key}
                      focusItem={focusFor(s, status)}
                      className={cn("-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-plan-track/70", PLAN_FOCUS)}
                    >
                      <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{s.label}</span>
                      <span className="flex flex-wrap items-center justify-end gap-1"><Flags status={status} save="saved" /></span>
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-plan-ink-2" />
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {providedCount > 0 ? (
          <p className="px-1 text-sm text-pretty text-plan-ink-2 max-sm:px-0">
            You already answered {providedCount === 1 ? "1 question" : `${providedCount} questions`} in your proposal; there&apos;s no need to enter them again.{" "}
            <NavLink view={PROVIDED_SECTION} data-testid={`overview-${PROVIDED_SECTION}`} className={cn("rounded-sm font-medium text-foreground underline underline-offset-4", PLAN_FOCUS)}>
              See what you already provided
            </NavLink>
          </p>
        ) : null}
      </div>

      <section aria-label="Your plan" className={cn(OVERVIEW_SHEET, "gap-6")}>
        {general.length > 0 ? (
          <div className="grid gap-1.5">
            <h2 id="plan-details-heading" className="text-base font-semibold">Event details</h2>
            <ul className="grid" aria-labelledby="plan-details-heading" data-testid="plan-details">
              {general.map((row) => <OverviewRow key={row.s.key} row={row} next={!closed && next?.key === row.s.key} />)}
            </ul>
          </div>
        ) : null}
        {stages.length > 0 ? (
          <div className="grid gap-1.5">
            <h2 id="plan-order-heading" className="text-base font-semibold">{nav.stagesHeading}</h2>
            <ol className="grid" aria-labelledby="plan-order-heading" data-testid="plan-order">
              {stages.map((row, i) => <OverviewRow key={row.s.key} row={row} number={i + 1} next={!closed && next?.key === row.s.key} connect={i < stages.length - 1} />)}
            </ol>
          </div>
        ) : null}
      </section>

    </div>
  );
}

/**
 * One section of the plan: its status in words and as a glyph, any flags, and a way in.
 * Stages are numbered and joined by a hairline: the event's order, not a to-do list.
 */
function OverviewRow({ row: { s, status }, number, next, connect }: { row: Row; number?: number; next: boolean; connect?: boolean }) {
  // What's been entered so far: a general section's own answers, or a stage's details (place and time).
  const summary = useAnswerSummary(s.id, s.kind === "general" ? s.editor : s.stageEditor);
  return (
    <li className="relative">
      {connect ? <span aria-hidden className="absolute top-[2.125rem] -bottom-[0.875rem] left-[1.25rem] w-px -translate-x-1/2 bg-plan-hairline" /> : null}
      <NavLink
        view={s.key}
        focusItem={isIncomplete(status) ? focusFor(s, status) : null}
        data-testid={`overview-${s.key}`}
        className={cn("-mx-3 grid min-h-14 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl px-3 py-3 hover:bg-plan-track/60", PLAN_FOCUS)}
      >
        <span className="relative pt-0.5"><StatusGlyph status={status} /></span>
        <span className="grid min-w-0 gap-0.5">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">
            {number !== undefined ? <span className="font-normal text-plan-ink-2 tabular-nums">{number}. </span> : null}
            {s.label}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-plan-ink-2">
            <span>{statusText(status)}</span>
            <Flags status={status} save="saved" />
          </span>
          {summary ? <span className="truncate text-sm text-foreground/80" data-testid="overview-preview">{summary}</span> : null}
        </span>
        <span className="flex items-center gap-2 self-center">
          {next ? <span className="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-medium text-brand-ink">Next up</span> : null}
          <ChevronRight aria-hidden className="size-4 text-plan-ink-2" />
        </span>
      </NavLink>
    </li>
  );
}
