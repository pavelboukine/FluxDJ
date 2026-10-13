"use client";

import { forwardRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import { GearThumb } from "@/components/app/gear-thumb";
import { fieldClass } from "@/components/app/list";
import { groupByCategory, type CategoryRef } from "@/lib/catalog/categories";
import { cn } from "@/lib/utils";

/** Above this many choices in total, a search box narrows them. */
const SEARCH_FROM = 8;

export type PickerChoice = {
  id: string;
  label: string;
  detail?: string;
  thumbUrl?: string | null;
  /** Gear category; choices from two or more categories are grouped under collapsible headings. */
  category?: CategoryRef;
};

/**
 * "Add" buttons for catalog choices inside a form (gear, questions): every
 * choice in a scrollable panel of bounded height (no "type to find others"),
 * grouped by category when there are several, with a search box when the
 * catalog is long (decided by `total`, so it doesn't vanish while adding).
 * Searching shows matches from every category, collapsed or not. Enter in
 * the search adds the first match instead of submitting; the arrow keys move
 * between choices; every button has an accessible name.
 */
export const ChoicePicker = forwardRef<HTMLInputElement, {
  /** What is being added, for labels: "gear", "a question". */
  noun: string;
  /** Choices not yet added. */
  available: PickerChoice[];
  /** How many active choices exist in all (added or not). */
  total: number;
  onAdd: (id: string) => void;
  thumbs?: boolean;
  emptyText: string;
  allAddedText: string;
  /** Heading for choices without a category when grouped. */
  uncategorizedLabel?: string;
}>(function ChoicePicker({ noun, available, total, onAdd, thumbs, emptyText, allAddedText, uncategorizedLabel = "Uncategorized" }, ref) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const q = query.trim().toLowerCase();
  const matches = q ? available.filter((c) => c.label.toLowerCase().includes(q) || (c.category?.name.toLowerCase().includes(q) ?? false)) : available;
  const searchable = total > SEARCH_FROM;
  const groups = groupByCategory(matches, (c) => c.category);
  const grouped = groupByCategory(available, (c) => c.category).length > 1;

  function add(id: string) {
    onAdd(id);
    setQuery("");
  }

  function toggle(key: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Arrow keys move between the panel's buttons (choices and group headings); Home and End jump. */
  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    buttons[next]?.focus();
  }

  if (total === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  if (available.length === 0) return <p className="text-xs text-muted-foreground">{allAddedText}</p>;

  const row = (c: PickerChoice) => (
    <li key={c.id}>
      <button
        type="button"
        onClick={() => add(c.id)}
        aria-label={`Add ${c.label}`}
        data-add
        className="flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {thumbs ? <GearThumb url={c.thumbUrl ?? null} className="size-8" /> : null}
        <span className="grid min-w-0 flex-1">
          <span className="truncate font-medium">{c.label}</span>
          {c.detail ? <span className="truncate text-xs text-muted-foreground">{c.detail}</span> : null}
        </span>
        <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );

  return (
    <div className="grid min-w-0 gap-2" role="group" aria-label={`Add ${noun}`} data-picker>
      {searchable ? (
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          {`Find ${noun} to add`}
          <span className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={ref}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (matches[0]) add(matches[0].id);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.currentTarget.closest("[data-picker]")?.querySelector<HTMLButtonElement>("[data-picker-panel] button")?.focus();
                }
              }}
              placeholder={grouped ? "Name or category" : "Name"}
              className={cn(fieldClass, "w-full pl-8 text-foreground")}
            />
          </span>
        </label>
      ) : (
        <p className="text-xs font-medium text-muted-foreground">{`Add ${noun}`}</p>
      )}
      {matches.length > 0 ? (
        <div data-picker-panel onKeyDown={onPanelKeyDown} className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border">
          {grouped ? (
            groups.map((g) => {
              // While searching, every category shows its matches.
              const open = q !== "" || !collapsed.has(g.key);
              const id = `picker-${noun.replace(/\W+/g, "-")}-${g.key.replace(/\W+/g, "-")}`;
              return (
                <div key={g.key} role="group" aria-label={g.name ?? uncategorizedLabel} className="border-b last:border-b-0">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => toggle(g.key)}
                    disabled={q !== ""}
                    className="sticky top-0 z-10 flex min-h-9 w-full items-center gap-2 bg-muted/90 px-3 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-default"
                  >
                    <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
                    <span className="flex-1">{g.name ?? uncategorizedLabel}</span>
                    <span className="font-normal tabular-nums normal-case">{g.items.length}</span>
                  </button>
                  {open ? (
                    <ul id={id} className="divide-y">
                      {g.items.map(row)}
                    </ul>
                  ) : null}
                </div>
              );
            })
          ) : (
            <ul className="divide-y">{matches.map(row)}</ul>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No {noun} matches “{query.trim()}”.</p>
      )}
      <p className="text-xs text-muted-foreground">
        {q ? `${matches.length} of ${available.length} shown.` : `${available.length} to choose from${grouped ? `, in ${groups.length} categories` : ""}.`}
      </p>
    </div>
  );
});
