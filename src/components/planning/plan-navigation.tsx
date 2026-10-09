"use client";

import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Circle, CircleCheck, CircleDot, CircleMinus, Clock, TriangleAlert } from "lucide-react";
import {
  SECTION_PARAM,
  WORKSPACE_ID,
  headingId,
  panelId,
  neighbours,
  resolveSection,
  sectionSearch,
  sectionStatus,
  type PlanSection,
  type SectionMoment,
  type SectionStatus,
} from "@/lib/planning/navigation";
import { cn } from "@/lib/utils";
import { ItemStatus, usePlanProgress } from "./progress";
import { SaveScope, useItemSaveSummary, useNotSavedSections, useSaveStore, useSectionSaveSummary, type SaveSummary } from "./save-registry";

/**
 * Planning, one section at a time (the client's page and the staff page). The open section is the
 * `section` query parameter (a library key, never a label or an answer), so
 * refresh, Back/Forward and direct links work; it changes with the History
 * API, without a server round trip. Every section stays mounted and the
 * inactive ones are only hidden, so switching never discards input: a
 * pending, debounced or failed save keeps running or waiting in its editor,
 * and the navigation says where something isn't saved yet.
 */

/** A view that isn't a plan section (proposal answers, settings), listed after the stages. Keys contain "-", so they never match a library key. */
export type ExtraView = { key: string; label: string };

type Nav = {
  sections: PlanSection[];
  extras: ExtraView[];
  stagesHeading: string;
  /** The open view: a section key, an extra view's key, or null for the overview. */
  active: string | null;
  go: (view: string | null, focusItem?: string | null) => void;
  href: (view: string | null) => string;
  labelOf: (view: string | null) => string;
};

const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("Planning navigation is missing");
  return nav;
}


export function PlanNavigation({ sections, extras = [], stagesHeading = "Your event, in order", children }: {
  sections: PlanSection[];
  extras?: ExtraView[];
  stagesHeading?: string;
  children: ReactNode;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const store = useSaveStore();
  const raw = params.get(SECTION_PARAM);
  const extraKeys = extras.map((x) => x.key);
  const active = resolveSection(raw, sections, extraKeys);
  const activeRef = useRef(active);
  const pendingFocus = useRef<{ view: string | null; item: string | null } | null>(null);
  // An unknown, hidden or removed section opens the overview, and the parameter is dropped.
  const [fellBack, setFellBack] = useState(() => raw !== null && active === null);
  useEffect(() => {
    if (raw !== null && active === null) {
      window.history.replaceState(null, "", `${window.location.pathname}${sectionSearch(window.location.search, null)}`);
    }
  }, [raw, active]);

  const focusView = useCallback((target: { view: string | null; item: string | null }) => {
    const panel = document.getElementById(panelId(target.view));
    let el: HTMLElement | null = null;
    if (target.item && panel) {
      const item = panel.querySelector<HTMLElement>(`[data-plan-item="${CSS.escape(target.item)}"]`);
      if (item instanceof HTMLDetailsElement) item.open = true;
      el = item ? (item.querySelector<HTMLElement>(":scope > summary") ?? item) : null;
    }
    const heading = document.getElementById(headingId(target.view));
    (el ?? heading)?.focus({ preventScroll: true });
    // Instant scrolling (never smooth), so reduced-motion preferences are respected.
    (el ?? document.getElementById(WORKSPACE_ID))?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    activeRef.current = active;
    const target = pendingFocus.current;
    if (target && target.view === active) {
      pendingFocus.current = null;
      focusView(target);
    }
  }, [active, focusView]);

  const go = useCallback((view: string | null, focusItem: string | null = null) => {
    // Leaving a section sends its waiting (debounced) saves now; its editors stay mounted either way.
    if (view !== activeRef.current) store?.flush(activeRef.current);
    setFellBack(false);
    const target = { view, item: focusItem };
    if (view === activeRef.current) {
      focusView(target);
      return;
    }
    pendingFocus.current = target;
    window.history.pushState(null, "", `${window.location.pathname}${sectionSearch(window.location.search, view)}`);
  }, [store, focusView]);

  const value: Nav = {
    sections,
    extras,
    stagesHeading,
    active,
    go,
    href: (view) => `${pathname}${sectionSearch(params.toString(), view)}`,
    labelOf: (view) => (view === null ? "Overview" : (extras.find((x) => x.key === view)?.label ?? sections.find((s) => s.key === view)?.label ?? "")),
  };

  return (
    <NavContext.Provider value={value}>
      {fellBack ? (
        <p role="status" className="rounded-xl border bg-card p-3 text-sm">
          That section isn&apos;t part of your plan any more, so the overview is shown instead.
        </p>
      ) : null}
      {children}
    </NavContext.Provider>
  );
}

/** Follows a plain click without reloading; modified clicks open the link normally. */
function onNavClick(e: MouseEvent<HTMLAnchorElement>, run: () => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  run();
}

export function NavLink({ view, focusItem, className, children, onPicked, ...rest }: {
  view: string | null;
  focusItem?: string | null;
  className?: string;
  children: ReactNode;
  onPicked?: () => void;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const nav = useNav();
  return (
    <a
      {...rest}
      href={nav.href(view)}
      className={className}
      onClick={(e) =>
        onNavClick(e, () => {
          onPicked?.();
          nav.go(view, focusItem);
        })
      }
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function useSectionStatus(section: PlanSection): SectionStatus | null {
  const plan = usePlanProgress();
  return plan ? sectionStatus(section, plan.progress, plan.warnings) : null;
}

/** The item to bring into view when opening a section for its open details; the heading is enough for the first one. */
export function focusFor(section: PlanSection, status: SectionStatus): string | null {
  return status.firstOpenItem && status.firstOpenItem !== section.itemIds[0] ? status.firstOpenItem : null;
}

export function statusText(s: SectionStatus): string {
  switch (s.state) {
    case "complete":
      return "Complete";
    case "not_applicable":
      return "Not applicable";
    case "in_progress":
      return `${s.met} of ${s.total} answered`;
    case "not_started":
      return "Not started";
    case "nothing":
      return "Optional";
  }
}

export function StatusIcon({ status }: { status: SectionStatus }) {
  const cls = "size-4 shrink-0";
  if (status.state === "complete") return <CircleCheck aria-hidden className={cn(cls, "text-emerald-700 dark:text-emerald-400")} />;
  if (status.state === "not_applicable") return <CircleMinus aria-hidden className={cn(cls, "text-muted-foreground")} />;
  if (status.state === "in_progress") return <CircleDot aria-hidden className={cn(cls, "text-amber-700 dark:text-amber-400")} />;
  return <Circle aria-hidden className={cn(cls, "text-muted-foreground")} />;
}

/** Discuss, timing and save flags. Saving is shown in the navigation only; the editor itself says so next to the fields. */
export function Flags({ status, save, showPending }: { status: SectionStatus | null; save: SaveSummary; showPending?: boolean }) {
  return (
    <>
      {save === "not_saved" ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          <TriangleAlert aria-hidden className="size-3" /> Not saved
        </span>
      ) : save === "pending" && showPending ? (
        <span className="text-xs text-muted-foreground">Saving…</span>
      ) : null}
      {status && status.discuss > 0 ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{status.discuss === 1 ? "1 to discuss" : `${status.discuss} to discuss`}</span>
      ) : null}
      {status && status.warnings > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300">
          <Clock aria-hidden className="size-3" /> Check timing
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Navigation: desktop column and phone picker
// ---------------------------------------------------------------------------

function SectionNavItem({ section, number, onPicked }: { section: PlanSection; number?: number; onPicked?: () => void }) {
  const nav = useNav();
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  const current = nav.active === section.key;
  return (
    <li>
      <NavLink
        view={section.key}
        onPicked={onPicked}
        aria-current={current ? "page" : undefined}
        data-testid={`nav-${section.key}`}
        className={cn(
          "grid min-h-11 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 rounded-lg px-2.5 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          current ? "bg-muted font-semibold" : "hover:bg-muted/60",
        )}
      >
        <span className="pt-0.5">{status ? <StatusIcon status={status} /> : null}</span>
        <span className="grid min-w-0 gap-0.5">
          <span className="[overflow-wrap:anywhere]">
            {number !== undefined ? <span className="text-muted-foreground">{number}. </span> : null}
            {section.label}
          </span>
          <span className="flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">
            {status ? <span>{statusText(status)}</span> : null}
            <Flags status={status} save={save} showPending />
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function SectionNavList({ onPicked }: { onPicked?: () => void }) {
  const nav = useNav();
  const general = nav.sections.filter((s) => s.kind === "general");
  const stages = nav.sections.filter((s) => s.kind === "stage");
  const plain = (view: string | null, label: string) => (
    <li>
      <NavLink
        view={view}
        onPicked={onPicked}
        data-testid={`nav-${view ?? "overview"}`}
        aria-current={nav.active === view ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center rounded-lg px-2.5 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          nav.active === view ? "bg-muted font-semibold" : "hover:bg-muted/60",
        )}
      >
        {label}
      </NavLink>
    </li>
  );
  return (
    <div className="grid gap-3">
      <ul className="grid gap-0.5">{plain(null, "Overview")}</ul>
      {general.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="px-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Event details</h3>
          <ul className="grid gap-0.5">
            {general.map((s) => <SectionNavItem key={s.key} section={s} onPicked={onPicked} />)}
          </ul>
        </div>
      ) : null}
      {stages.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="px-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{nav.stagesHeading}</h3>
          <ol className="grid gap-0.5" aria-label="Stages of the event, in order">
            {stages.map((s, i) => <SectionNavItem key={s.key} section={s} number={i + 1} onPicked={onPicked} />)}
          </ol>
        </div>
      ) : null}
      {nav.extras.length > 0 ? <ul className="grid gap-0.5 border-t pt-3">{nav.extras.map((x) => <Fragment key={x.key}>{plain(x.key, x.label)}</Fragment>)}</ul> : null}
    </div>
  );
}

/** Desktop: the planning navigation column. */
export function PlanSidebar() {
  return (
    <nav aria-label="Planning sections" className="hidden rounded-2xl border bg-card p-2 shadow-sm lg:block">
      <SectionNavList />
    </nav>
  );
}

/** Phones and tablets: the current section and its progress; opens the same list inline (no nested scrolling). */
export function SectionPicker() {
  const nav = useNav();
  const ref = useRef<HTMLDetailsElement>(null);
  const section = nav.sections.find((s) => s.key === nav.active) ?? null;
  const index = section ? nav.sections.indexOf(section) : -1;
  return (
    <details ref={ref} className="group/picker rounded-2xl border bg-card shadow-sm lg:hidden" data-testid="section-picker">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="grid min-w-0 gap-0.5">
          <span className="text-xs text-muted-foreground">
            {section ? `Section ${index + 1} of ${nav.sections.length}` : "Planning sections"}
            <span className="sr-only">. Choose a section.</span>
          </span>
          <span className="font-semibold [overflow-wrap:anywhere]">{nav.labelOf(nav.active)}</span>
          {section ? <PickerStatus section={section} /> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
          All sections
          <ChevronDown aria-hidden className="size-4 transition-transform group-open/picker:rotate-180 motion-reduce:transition-none" />
        </span>
      </summary>
      <nav aria-label="Planning sections" className="border-t p-2">
        <SectionNavList
          onPicked={() => {
            if (ref.current) ref.current.open = false;
          }}
        />
      </nav>
    </details>
  );
}

function PickerStatus({ section }: { section: PlanSection }) {
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {status ? <span>{statusText(status)}</span> : null}
      <Flags status={status} save={save} showPending />
    </span>
  );
}

/** Sections other than the open one with input that wasn't saved; never hidden silently. */
export function UnsavedElsewhere() {
  const nav = useNav();
  const keys = useNotSavedSections().filter((k) => k !== nav.active);
  if (keys.length === 0) return null;
  return (
    <div role="status" data-testid="unsaved-elsewhere" className="grid gap-2 rounded-xl border border-destructive/50 bg-card p-3 text-sm">
      <p className="font-medium">Some changes weren&apos;t saved. They&apos;re still on this page:</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {keys.map((k) => (
          <li key={k}>
            <NavLink view={k} className="inline-flex min-h-11 items-center rounded-md font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              Open {nav.labelOf(k)}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** One view's content. Hidden (never unmounted) while another view is open. */
export function PlanPanel({ view, testId, children }: { view: string | null; testId?: string; children: ReactNode }) {
  const nav = useNav();
  return (
    <div id={panelId(view)} hidden={nav.active !== view} data-testid={testId} className="grid min-w-0 gap-4">
      <SaveScope section={view}>{children}</SaveScope>
    </div>
  );
}

export function SectionHeader({ sectionKey, eyebrow }: { sectionKey: string; eyebrow: string }) {
  const nav = useNav();
  const section = nav.sections.find((s) => s.key === sectionKey)!;
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{eyebrow}</p>
      <h2 id={headingId(sectionKey)} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none [overflow-wrap:anywhere] focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-2xl">
        {section.label}
      </h2>
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground" data-testid="section-status">
        {status ? <StatusIcon status={status} /> : null}
        {status ? <span>{status.state === "in_progress" || status.state === "not_started" ? `${statusText(status)} · ${status.total - status.met} still needed` : statusText(status)}</span> : null}
        <Flags status={status} save={save} />
      </p>
    </div>
  );
}

export function PanelHeading({ view, children }: { view: string | null; children: ReactNode }) {
  return (
    <h2 id={headingId(view)} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-2xl">
      {children}
    </h2>
  );
}

/** A moment of the open stage, as a disclosure (long stages stay scannable). */
export function PlanMoment({ moment, defaultOpen, children }: { moment: SectionMoment; defaultOpen?: boolean; children: ReactNode }) {
  const save = useItemSaveSummary(moment.id);
  return (
    <details open={defaultOpen} data-plan-item={moment.id} data-testid={`moment-${moment.key}`} className="group/moment rounded-xl border bg-background">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <h3 className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{moment.label}</h3>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Flags status={null} save={save} />
          <ItemStatus itemId={moment.id} />
          <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open/moment:rotate-90 motion-reduce:transition-none" />
        </span>
      </summary>
      <div className="border-t px-4 py-4 text-sm">
        <SaveScope item={moment.id}>{children}</SaveScope>
      </div>
    </details>
  );
}

/** Previous and Next in plan order. Incomplete answers never block moving on. */
export function SectionPager({ view }: { view: string | null }) {
  const nav = useNav();
  const { previous, next } = neighbours(nav.sections, nav.extras.map((x) => x.key), view);
  const link = "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-xl border bg-card px-3 text-sm font-medium outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <nav aria-label="Previous and next section" className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
      {previous ? (
        <NavLink view={previous.key} className={link} rel="prev">
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate"><span className="sr-only">Previous: </span>{nav.labelOf(previous.key)}</span>
        </NavLink>
      ) : <span />}
      {next ? (
        <NavLink view={next.key} className={cn(link, "ml-auto")} rel="next">
          <span className="min-w-0 truncate"><span className="text-muted-foreground">Next: </span>{nav.labelOf(next.key)}</span>
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        </NavLink>
      ) : null}
    </nav>
  );
}

