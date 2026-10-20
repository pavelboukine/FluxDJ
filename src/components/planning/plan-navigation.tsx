"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Minus, TriangleAlert, X } from "lucide-react";
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
  type SectionState,
  type SectionStatus,
} from "@/lib/planning/navigation";
import { progressPercentText } from "@/lib/planning/view";
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
 * and the navigation says where something isn't saved yet. Leaving a section
 * resets its question disclosures to how they first appeared; only that UI
 * state changes, never an answer or a draft.
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

  // Leaving a section, however it happens (Next, Previous, the section list, links, Back and
  // Forward): its questions go back to how they first appeared (collapsed, or open when the
  // section has just one), so returning finds it tidy. Only the disclosures change: every
  // editor stays mounted with its input, and waiting saves are sent first (a no-op when go()
  // already sent them), so nothing typed is dropped and a failed save keeps its Retry.
  const shownRef = useRef(active);
  useEffect(() => {
    const left = shownRef.current;
    shownRef.current = active;
    if (left === active) return;
    store?.flush(left);
    document.getElementById(panelId(left))?.querySelectorAll<HTMLDetailsElement>("details[data-plan-item]").forEach((d) => {
      d.open = d.hasAttribute("data-default-open");
    });
  }, [active, store]);

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

/**
 * A section's status as a small glyph, always shown next to its words (never alone).
 * Deliberately unlike a form control (no outlined ring, no centre dot): a filled grey disc
 * when not started, a half-filled disc when in progress (a state, not a percentage: the
 * words beside it carry the exact count), a check when complete and a dash when not
 * applicable.
 */
export function StatusGlyph({ status, className }: { status: SectionStatus; className?: string }) {
  return <ProgressGlyph state={status.state} className={className} />;
}

export function ProgressGlyph({ state, className }: { state: SectionState; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  if (state === "complete") {
    return (
      <span aria-hidden className={cn(base, "inline-grid place-items-center rounded-full bg-status-done text-white")}>
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  }
  if (state === "not_applicable") {
    return (
      <span aria-hidden className={cn(base, "inline-grid place-items-center rounded-full bg-plan-track text-plan-ink-2")}>
        <Minus className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn(base, "text-brand-ink")}>
      <circle cx="8" cy="8" r="8" className="fill-plan-track" />
      {/* In progress: the right half, always the same. */}
      {state === "in_progress" ? <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" /> : null}
    </svg>
  );
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
        <span className="text-xs text-plan-ink-2">Saving…</span>
      ) : null}
      {status && status.discuss > 0 ? (
        <span className="rounded-full bg-plan-track px-2 py-0.5 text-xs font-medium text-foreground">{status.discuss === 1 ? "1 to discuss" : `${status.discuss} to discuss`}</span>
      ) : null}
      {status && status.warnings > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-status-attention-tint px-2 py-0.5 text-xs font-medium text-status-attention">
          <Clock aria-hidden className="size-3" /> Check timing
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Navigation: desktop column and phone section bar + sheet
// ---------------------------------------------------------------------------

/** Keyboard focus on planning navigation: a solid Brand Ink ring (at least 3:1 against white and the tints). */
export const PLAN_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-1";

const navItem = (current: boolean) =>
  cn(
    "grid min-h-11 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors motion-reduce:transition-none",
    PLAN_FOCUS,
    current ? "bg-brand-tint font-semibold text-foreground" : "text-foreground hover:bg-plan-track/70",
  );

function SectionNavItem({ section, number, onPicked }: { section: PlanSection; number?: number; onPicked?: () => void }) {
  const nav = useNav();
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  const current = nav.active === section.key;
  return (
    <li>
      <NavLink view={section.key} onPicked={onPicked} aria-current={current ? "page" : undefined} data-testid={`nav-${section.key}`} className={navItem(current)}>
        <span className="pt-0.5">{status ? <StatusGlyph status={status} /> : null}</span>
        <span className="grid min-w-0 gap-0.5">
          <span className="[overflow-wrap:anywhere]">
            {number !== undefined ? <span className="font-normal text-plan-ink-2 tabular-nums">{number}. </span> : null}
            {section.label}
          </span>
          <span className="flex flex-wrap items-center gap-1 text-xs font-normal text-plan-ink-2">
            {status ? <span>{statusText(status)}</span> : null}
            <Flags status={status} save={save} showPending />
          </span>
        </span>
      </NavLink>
    </li>
  );
}

/** The plan's overall progress as a glyph (the overview's own status). */
function OverallGlyph() {
  const plan = usePlanProgress();
  if (!plan) return <ProgressGlyph state="nothing" />;
  const { requirements_met: met, requirements_total: total } = plan.progress;
  return <ProgressGlyph state={total === 0 ? "nothing" : met >= total ? "complete" : met > 0 ? "in_progress" : "not_started"} />;
}

/** The overview, as a navigation item like the sections (glyph, label, status line), never a heading. */
function OverviewNavItem({ onPicked }: { onPicked?: () => void }) {
  const nav = useNav();
  const plan = usePlanProgress();
  const current = nav.active === null;
  const percent = plan ? progressPercentText(plan.progress) : null;
  return (
    <li>
      <NavLink view={null} onPicked={onPicked} aria-current={current ? "page" : undefined} data-testid="nav-overview" className={navItem(current)}>
        <span className="pt-0.5"><OverallGlyph /></span>
        <span className="grid min-w-0 gap-0.5">
          <span>Overview</span>
          <span className="text-xs font-normal text-plan-ink-2">{percent ?? "Progress and next steps"}</span>
        </span>
      </NavLink>
    </li>
  );
}

function SectionNavList({ onPicked, idPrefix }: { onPicked?: () => void; idPrefix: string }) {
  const nav = useNav();
  const general = nav.sections.filter((s) => s.kind === "general");
  const stages = nav.sections.filter((s) => s.kind === "stage");
  const group = "px-2.5 pb-1 text-xs font-medium text-plan-ink-2";
  return (
    <div className="grid gap-4">
      <ul className="grid gap-0.5"><OverviewNavItem onPicked={onPicked} /></ul>
      {general.length > 0 ? (
        <div>
          <p id={`${idPrefix}-general`} className={group}>Event details</p>
          <ul className="grid gap-0.5" aria-labelledby={`${idPrefix}-general`}>
            {general.map((s) => <SectionNavItem key={s.key} section={s} onPicked={onPicked} />)}
          </ul>
        </div>
      ) : null}
      {stages.length > 0 ? (
        <div>
          <p aria-hidden className={group}>{nav.stagesHeading}</p>
          <ol className="grid gap-0.5" aria-label="Stages of the event, in order">
            {stages.map((s, i) => <SectionNavItem key={s.key} section={s} number={i + 1} onPicked={onPicked} />)}
          </ol>
        </div>
      ) : null}
      {nav.extras.length > 0 ? (
        <ul className="grid gap-0.5 border-t border-plan-hairline pt-3">
          {nav.extras.map((x) => (
            <li key={x.key}>
              <NavLink
                view={x.key}
                onPicked={onPicked}
                data-testid={`nav-${x.key}`}
                aria-current={nav.active === x.key ? "page" : undefined}
                className={cn(navItem(nav.active === x.key), "flex items-center")}
              >
                {x.label}
              </NavLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Desktop: the planning navigation, unboxed on the canvas; it stays in view on long sections.
 * With hideOnOverview, the overview goes without it: its own rows lead to every section, so
 * the two lists aren't shown side by side (the workspace grid follows data-plan-sidebar).
 */
export function PlanSidebar({ hideOnOverview = false }: { hideOnOverview?: boolean }) {
  const nav = useNav();
  if (hideOnOverview && nav.active === null) return null;
  return (
    <nav
      aria-label="Planning sections"
      data-plan-sidebar
      className="hidden lg:sticky lg:top-[calc(var(--plan-sticky-top,0px)+1.5rem)] lg:block lg:max-h-[calc(100dvh-var(--plan-sticky-top,0px)-3rem)] lg:-mx-1 lg:overflow-y-auto lg:overscroll-contain lg:px-1 lg:pt-1 lg:pb-4"
    >
      <SectionNavList idPrefix="plan-nav" />
    </nav>
  );
}

/**
 * Phones and tablets: a slim bar that stays at the top with the open section and its
 * progress. "All sections" opens the same list as a modal sheet (Escape, the close button
 * or picking a section closes it; focus returns to the bar, or moves to the picked section).
 */
export function SectionPicker() {
  const nav = useNav();
  const sheet = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const section = nav.sections.find((s) => s.key === nav.active) ?? null;
  const close = () => sheet.current?.close();
  const show = () => {
    const d = sheet.current;
    if (!d || d.open) return;
    d.showModal();
    setOpen(true);
    const current = d.querySelector<HTMLElement>('[aria-current="page"]');
    current?.focus();
    current?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div
      data-testid="section-picker"
      className="sticky top-[var(--plan-sticky-top,0px)] z-30 -mx-4 border-b border-plan-hairline bg-plan-canvas px-4 sm:mx-0 sm:rounded-b-xl sm:px-0 lg:hidden"
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
        className={cn("flex min-h-14 w-full items-center gap-3 rounded-lg py-2 text-left sm:px-1", PLAN_FOCUS)}
      >
        {section ? <PickerGlyph section={section} /> : <OverallGlyph />}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-semibold">{nav.labelOf(nav.active)}</span>
          {section ? <PickerStatus section={section} /> : <OverviewStatus />}
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded-lg px-1 text-sm font-medium">
          All sections
          <ChevronDown aria-hidden className="size-4" />
        </span>
      </button>
      <dialog
        ref={sheet}
        data-plan-sheet
        aria-labelledby="plan-sheet-title"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-full overscroll-contain bg-plan-surface p-0 text-foreground shadow-xl backdrop:bg-black/30 sm:w-[26rem] motion-safe:open:animate-in motion-safe:open:fade-in-0 motion-safe:open:slide-in-from-bottom-4 motion-safe:sm:open:slide-in-from-bottom-0 motion-safe:sm:open:slide-in-from-right-8"
      >
        <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]">
          <div className="flex min-h-14 items-center justify-between gap-3 border-b border-plan-hairline px-4">
            <h2 id="plan-sheet-title" className="text-base font-semibold">Planning sections</h2>
            <button
              type="button"
              onClick={close}
              className={cn("-mr-2 inline-flex size-11 items-center justify-center rounded-lg hover:bg-plan-track/70", PLAN_FOCUS)}
            >
              <X aria-hidden className="size-5" />
              <span className="sr-only">Close</span>
            </button>
          </div>
          <nav aria-label="Planning sections" className="flex-1 overflow-y-auto overscroll-contain px-2 py-3">
            <SectionNavList idPrefix="plan-sheet" onPicked={close} />
          </nav>
        </div>
      </dialog>
    </div>
  );
}

function PickerGlyph({ section }: { section: PlanSection }) {
  const status = useSectionStatus(section);
  return status ? <StatusGlyph status={status} /> : null;
}

function PickerStatus({ section }: { section: PlanSection }) {
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs text-plan-ink-2">
      {status ? <span>{statusText(status)}</span> : null}
      <Flags status={status} save={save} showPending />
    </span>
  );
}

function OverviewStatus() {
  const plan = usePlanProgress();
  const percent = plan ? progressPercentText(plan.progress) : null;
  return <span className="text-xs text-plan-ink-2">{percent ?? "Progress and next steps"}</span>;
}

/** Sections other than the open one with input that wasn't saved; never hidden silently. */
export function UnsavedElsewhere() {
  const nav = useNav();
  const keys = useNotSavedSections().filter((k) => k !== nav.active);
  if (keys.length === 0) return null;
  return (
    <div role="status" data-testid="unsaved-elsewhere" className="grid gap-1 rounded-xl border border-destructive/40 bg-plan-surface px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        Some changes weren&apos;t saved. They&apos;re still on this page:
      </p>
      <ul className="flex flex-wrap gap-x-4 pl-6">
        {keys.map((k) => (
          <li key={k}>
            <NavLink view={k} className={cn("inline-flex min-h-11 items-center rounded-md font-medium underline underline-offset-4", PLAN_FOCUS)}>
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

/** The open section's title and one line of context: where it sits, its status and any flags. */
export function SectionHeader({ sectionKey, eyebrow }: { sectionKey: string; eyebrow: string }) {
  const nav = useNav();
  const section = nav.sections.find((s) => s.key === sectionKey)!;
  const status = useSectionStatus(section);
  const save = useSectionSaveSummary(section.key);
  return (
    <div className="grid gap-1.5">
      <h2 id={headingId(sectionKey)} tabIndex={-1} className={cn("rounded-sm text-xl leading-tight font-semibold tracking-tight text-balance [overflow-wrap:anywhere] sm:text-[1.375rem]", PLAN_FOCUS)}>
        {section.label}
      </h2>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-plan-ink-2">
        <span>{eyebrow}</span>
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="section-status">
          {status ? <StatusGlyph status={status} /> : null}
          {status ? <span>{status.state === "in_progress" || status.state === "not_started" ? `${statusText(status)} · ${status.total - status.met} still needed` : statusText(status)}</span> : null}
          <Flags status={status} save={save} />
        </span>
      </p>
    </div>
  );
}

export function PanelHeading({ view, children }: { view: string | null; children: ReactNode }) {
  return (
    <h2 id={headingId(view)} tabIndex={-1} className={cn("rounded-sm text-xl leading-tight font-semibold tracking-tight text-balance sm:text-[1.375rem]", PLAN_FOCUS)}>
      {children}
    </h2>
  );
}

/** A moment of the open stage, as a disclosure (long stages stay scannable). */
export function PlanMoment({ moment, defaultOpen, children }: { moment: SectionMoment; defaultOpen?: boolean; children: ReactNode }) {
  const save = useItemSaveSummary(moment.id);
  return (
    <details open={defaultOpen} data-default-open={defaultOpen ? "" : undefined} data-plan-item={moment.id} data-testid={`moment-${moment.key}`} className="group/moment rounded-xl border bg-background">
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

/**
 * Previous and Next in plan order. Incomplete answers never block moving on. On phones and
 * tablets the bar stays at the bottom of the screen, within thumb reach, while its section is
 * in view; it steps back into the page while a text field has focus (see globals.css), so the
 * on-screen keyboard never squeezes it over the field. The section sheet sets --plan-sheet-pad.
 */
export function SectionPager({ view }: { view: string | null }) {
  const nav = useNav();
  const { previous, next } = neighbours(nav.sections, nav.extras.map((x) => x.key), view);
  const base = cn("inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-[10px] px-3 text-sm font-medium", PLAN_FOCUS);
  return (
    <nav
      data-plan-pager
      aria-label="Previous and next section"
      className="z-20 -mx-[var(--plan-sheet-pad,0px)] flex items-center gap-2 border-t border-plan-hairline bg-plan-surface px-[var(--plan-sheet-pad,0px)] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-lg:sticky max-lg:bottom-0 lg:mx-0 lg:px-0 lg:pt-4 lg:pb-0"
    >
      {previous ? (
        <NavLink view={previous.key} className={cn(base, "max-w-[45%] text-foreground hover:bg-plan-track/70")} rel="prev">
          <ChevronLeft aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate"><span className="sr-only">Previous: </span>{nav.labelOf(previous.key)}</span>
        </NavLink>
      ) : null}
      {next ? (
        <NavLink view={next.key} className={cn(base, "ml-auto bg-brand pl-4 text-brand-foreground hover:bg-brand/90")} rel="next">
          <span className="min-w-0 truncate"><span className="opacity-80">Next: </span>{nav.labelOf(next.key)}</span>
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        </NavLink>
      ) : null}
    </nav>
  );
}
