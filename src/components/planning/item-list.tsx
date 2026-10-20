"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLAN_FOCUS, PLAN_PRIMARY } from "./plan-navigation";

/**
 * Planning's list pattern (songs, playlists, people, activities, dedications, vendors): compact
 * rows on hairlines, never a card per entry. Each row reads first (what it is), with quiet
 * reorder arrows and Edit as its one visible action; Remove lives in the edit panel, with the
 * same undo as before. Every control keeps its accessible name ('Move "X" up', 'Edit "X"',
 * 'Done editing "X"', 'Remove "X"'), so keyboard and screen-reader use is unchanged.
 */

export const ITEM_ROWS = "grid divide-y divide-plan-hairline border-y border-plan-hairline";

/** The panel an entry opens into, and the add forms: one light surface, nothing nested inside. */
export const ITEM_PANEL = "grid gap-4 rounded-xl bg-plan-surface p-3 ring-1 ring-plan-hairline sm:p-4";

const ICON_BUTTON = cn(
  "inline-flex size-9 items-center justify-center rounded-lg text-plan-ink-2 hover:bg-plan-track/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-30 max-sm:size-11",
  PLAN_FOCUS,
);
const TEXT_BUTTON = cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium max-sm:min-h-11", PLAN_FOCUS);

export function ItemRow({ testId, summary, actions, after, panel }: {
  testId: string;
  summary: ReactNode;
  /** Reorder and Edit. */
  actions?: ReactNode;
  /** Notes under the row that aren't part of its summary (why it can't be removed…). */
  after?: ReactNode;
  /** The edit panel, while open. */
  panel?: ReactNode;
}) {
  return (
    <li className="grid gap-2 py-3" data-testid={testId}>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5 text-sm">{summary}</div>
        {actions ? <div className="-mr-1 flex shrink-0 items-center">{actions}</div> : null}
      </div>
      {after}
      {panel ? <div className={ITEM_PANEL}>{panel}</div> : null}
    </li>
  );
}

export function ReorderButtons({ name, index, count, onMove }: { name: string; index: number; count: number; onMove: (by: -1 | 1) => void }) {
  return (
    <>
      <button type="button" className={ICON_BUTTON} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move "${name}" up`}>
        <ChevronUp aria-hidden className="size-4" />
      </button>
      <button type="button" className={ICON_BUTTON} disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move "${name}" down`}>
        <ChevronDown aria-hidden className="size-4" />
      </button>
    </>
  );
}

/** Edit, or Done while the panel is open. `noun` prefixes the name ('Edit playlist "Chill"'). */
export function EditToggle({ editing, name, noun, onToggle }: { editing: boolean; name: string; noun?: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={cn(TEXT_BUTTON, "text-brand-ink hover:bg-brand-tint")}
      onClick={onToggle}
      aria-expanded={editing}
      aria-label={`${editing ? "Done editing" : "Edit"} ${noun ? `${noun} ` : ""}"${name}"`}
    >
      {editing ? "Done" : "Edit"}
    </button>
  );
}

/** The panel's footer: Remove, apart from the fields (it can be undone right after). */
export function RemoveButton({ name, noun, ...props }: { name: string; noun?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "type">) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-plan-hairline pt-3">
      <button
        type="button"
        {...props}
        className={cn(TEXT_BUTTON, "text-destructive hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40")}
        aria-label={`Remove ${noun ? `${noun} ` : ""}"${name}"`}
      >
        <Trash2 aria-hidden className="size-4" />
        Remove
      </button>
    </div>
  );
}

/** "Removed …" with Undo, until the next change. */
export function UndoBar({ children, onUndo }: { children: ReactNode; onUndo: () => void }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-plan-track/60 px-3 py-1.5 text-sm">
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      <button type="button" onClick={onUndo} className={cn(TEXT_BUTTON, "px-1 underline underline-offset-4")}>Undo</button>
    </p>
  );
}

/** An add form behind one quiet "+ Add …" line; it opens on the light panel. */
export function AddDisclosure({ testId, label, defaultOpen, children }: { testId: string; label: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="group/add" data-testid={testId} open={defaultOpen}>
      <summary className={cn("w-fit cursor-pointer list-none text-brand-ink hover:bg-brand-tint [&::-webkit-details-marker]:hidden", TEXT_BUTTON, "-ml-1 px-1.5")}>
        <Plus aria-hidden className="size-4 transition-transform group-open/add:rotate-45 motion-reduce:transition-none" />
        {label}
      </summary>
      <div className={cn(ITEM_PANEL, "mt-2")}>{children}</div>
    </details>
  );
}

/** The add form's own button ("Add song", "Add", "Add playlist"). */
export function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex min-h-10 w-fit items-center rounded-[10px] px-4 text-sm font-semibold max-sm:min-h-11", PLAN_PRIMARY, PLAN_FOCUS)}>
      {children}
    </button>
  );
}
