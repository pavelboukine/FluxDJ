"use client";

import { ChevronRight } from "lucide-react";
import { headingId, isIncomplete, sectionStatus } from "@/lib/planning/navigation";
import { progressScopeNote } from "@/lib/planning/view";
import { ProgressMeter, usePlanProgress } from "./progress";
import { Flags, NavLink, PanelHeading, StatusIcon, focusFor, useNav } from "./plan-navigation";

/**
 * The staff planning overview: the database's progress (the same items and
 * requirement states the client sees, never recomputed) and what still needs
 * attention, each linking straight to its section and editor. Answers stay
 * in their sections; this only points at them.
 */
export function StaffPlanOverview() {
  const nav = useNav();
  const plan = usePlanProgress();
  if (!plan) return null;
  const p = plan.progress;
  const rows = nav.sections.map((s) => ({ s, status: sectionStatus(s, p, plan.warnings) }));
  const attention = rows.filter(({ status }) => isIncomplete(status) || status.discuss > 0 || status.warnings > 0);
  const discuss = rows.reduce((n, r) => n + r.status.discuss, 0);

  return (
    <section aria-labelledby={headingId(null)} className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="grid gap-2">
        <PanelHeading view={null}>Planning progress</PanelHeading>
        <ProgressMeter progress={p} bar="bg-primary" compact />
      </div>
      <p className="text-sm text-muted-foreground">
        {p.complete_sections} of {p.available_sections} {p.available_sections === 1 ? "section" : "sections"} complete
        {discuss > 0 ? ` · ${discuss} to discuss with the client` : ""}
        {plan.warnings.length > 0 ? ` · ${plan.warnings.length === 1 ? "1 timing note" : `${plan.warnings.length} timing notes`}` : ""}. {progressScopeNote(p)}{" "}
        Progress counts answers, by you or the client; it isn&apos;t an approval.
      </p>

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Needs attention</h3>
        {attention.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="plan-attention">Nothing open: every required answer in the available sections is in, with no timing notes.</p>
        ) : (
          <ul className="grid gap-0.5" data-testid="plan-attention">
            {attention.map(({ s, status }) => (
              <li key={s.key}>
                <NavLink
                  view={s.key}
                  focusItem={focusFor(s, status)}
                  className="grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <StatusIcon status={status} />
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{s.label}</span>
                    {isIncomplete(status) ? (
                      <span className="text-xs text-muted-foreground">
                        {status.total - status.met === 1 ? "1 answer needed" : `${status.total - status.met} answers needed`}
                      </span>
                    ) : null}
                    <Flags status={status} save="saved" />
                  </span>
                  <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
