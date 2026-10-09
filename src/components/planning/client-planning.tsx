"use client";

import { ChevronRight, Lock } from "lucide-react";
import { PROVIDED_SECTION, firstIncompleteSection, headingId, isIncomplete, sectionStatus } from "@/lib/planning/navigation";
import { progressHeadline, progressScopeNote } from "@/lib/planning/view";
import { cn } from "@/lib/utils";
import { usePlanProgress } from "./progress";
import { Flags, NavLink, PanelHeading, StatusIcon, focusFor, useNav } from "./plan-navigation";

/** The client's planning overview and editing chip (navigation itself is shared: plan-navigation). */

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const CHIP_TONES = {
  open: "bg-emerald-100 text-emerald-950 dark:bg-emerald-500/20 dark:text-emerald-100",
  reopened: "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100",
  closed: "bg-muted text-foreground",
} as const;

/** Whether the client can edit now; follows a save that finds planning closed. */
export function EditingChip() {
  const e = usePlanProgress()?.editing;
  if (!e) return null;
  return (
    <span data-testid="editing-chip" className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", CHIP_TONES[e.state])}>
      {e.state === "closed" ? <Lock aria-hidden className="size-3" /> : null}
      {e.state === "open" ? "Planning open" : e.state === "reopened" ? "Reopened" : "Read-only"}
    </span>
  );
}

export function PlanOverview({ djName, providedCount }: { djName: string; providedCount: number }) {
  const nav = useNav();
  const plan = usePlanProgress();
  if (!plan) return null;
  const p = plan.progress;
  const closed = plan.editing?.state === "closed";
  const next = firstIncompleteSection(nav.sections, p, plan.warnings);
  const first = nav.sections[0] ?? null;
  const open = nav.sections
    .map((s) => ({ s, status: sectionStatus(s, p, plan.warnings) }))
    .filter(({ status }) => isIncomplete(status) || status.discuss > 0 || status.warnings > 0);
  const button = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-[var(--brand-foreground)] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 max-sm:w-full";

  return (
    <div className="grid gap-4">
      <section aria-labelledby={headingId(null)} className="grid gap-4 rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="grid gap-1">
          <PanelHeading view={null}>Planning progress</PanelHeading>
          <p className="text-lg font-medium" data-testid="progress-headline">{progressHeadline(p)}</p>
        </div>
        {p.requirements_total > 0 ? (
          <div
            role="progressbar"
            aria-label="Required answers in available sections"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={p.percent ?? 0}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-[var(--brand)]" style={{ width: `${p.percent ?? 0}%` }} />
          </div>
        ) : null}
        <div className="grid gap-1 text-sm text-muted-foreground">
          <p>
            {p.complete_sections} of {p.available_sections} {p.available_sections === 1 ? "section" : "sections"} complete. {progressScopeNote(p)}
          </p>
          <p>
            Unanswered questions and anything marked &ldquo;Discuss with {djName}&rdquo; still count as open. Progress shows what you&apos;ve filled in; it
            doesn&apos;t mean {djName} has reviewed or approved your plan.
          </p>
        </div>
        {first ? (
          closed ? (
            <div className="flex flex-wrap items-center gap-3">
              <NavLink view={first.key} className={button} data-testid="plan-primary">View planning</NavLink>
              <p className="text-sm text-muted-foreground">Everything stays visible; changes now go through {djName}.</p>
            </div>
          ) : next ? (
            <div className="flex flex-wrap items-center gap-3">
              <NavLink view={next.key} focusItem={focusFor(next, sectionStatus(next, p, plan.warnings))} className={button} data-testid="plan-primary">
                Continue planning
              </NavLink>
              <p className="text-sm text-muted-foreground">Next up: {next.label}</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <NavLink view={first.key} className={button} data-testid="plan-primary">Review your plan</NavLink>
              <p className="text-sm text-muted-foreground">Every required answer in the available sections is in. You can still review and change them.</p>
            </div>
          )
        ) : null}
      </section>

      {open.length > 0 ? (
        <section aria-labelledby="plan-open-heading" className="grid gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
          <h2 id="plan-open-heading" className="text-base font-semibold">Still to sort out</h2>
          <ul className="grid gap-1" data-testid="plan-open">
            {open.map(({ s, status }) => (
              <li key={s.key}>
                <NavLink
                  view={s.key}
                  focusItem={focusFor(s, status)}
                  className="grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-2 text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <StatusIcon status={status} />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{s.label}</span>
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {isIncomplete(status) ? <span>{status.total - status.met === 1 ? "1 answer needed" : `${status.total - status.met} answers needed`}</span> : null}
                      <Flags status={status} save="saved" />
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {providedCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          You already answered {providedCount === 1 ? "1 question" : `${providedCount} questions`} in your proposal; there&apos;s no need to enter them again.{" "}
          <NavLink view={PROVIDED_SECTION} className="font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm">
            See what you already provided
          </NavLink>
        </p>
      ) : null}
    </div>
  );
}
