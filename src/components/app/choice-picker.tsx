"use client";

import { forwardRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GearThumb } from "@/components/app/gear-thumb";
import { fieldClass } from "@/components/app/list";
import { cn } from "@/lib/utils";

/** Above this many choices in total, a search box narrows them. */
const SEARCH_FROM = 8;
const SHOWN_MATCHES = 8;

export type PickerChoice = { id: string; label: string; detail?: string; thumbUrl?: string | null };

/**
 * "Add" buttons for catalog choices inside a form (gear, questions): a
 * search box when the catalog is long (decided by `total`, so it doesn't
 * vanish while adding), Enter adding the first match instead of submitting,
 * and an accessible name on every button.
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
}>(function ChoicePicker({ noun, available, total, onAdd, thumbs, emptyText, allAddedText }, ref) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (q ? available.filter((c) => c.label.toLowerCase().includes(q)) : available).slice(0, SHOWN_MATCHES);
  const searchable = total > SEARCH_FROM;

  function add(id: string) {
    onAdd(id);
    setQuery("");
  }

  if (total === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  if (available.length === 0) return <p className="text-xs text-muted-foreground">{allAddedText}</p>;
  return (
    <div className="grid min-w-0 gap-2" role="group" aria-label={`Add ${noun}`}>
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
                }
              }}
              placeholder="Name"
              className={cn(fieldClass, "w-full pl-8 text-foreground")}
            />
          </span>
        </label>
      ) : (
        <p className="text-xs font-medium text-muted-foreground">{`Add ${noun}`}</p>
      )}
      {matches.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {matches.map((c) => (
            <li key={c.id} className="max-w-full min-w-0">
              <Button type="button" variant="outline" className={cn("h-auto max-w-full gap-2 py-1 pr-3", thumbs ? "pl-1" : "pl-3")} onClick={() => add(c.id)} aria-label={`Add ${c.label}`} data-add>
                {thumbs ? <GearThumb url={c.thumbUrl ?? null} className="size-8" /> : null}
                <span className="grid min-w-0 text-left">
                  <span className="max-w-64 min-w-0 truncate">{c.label}</span>
                  {c.detail ? <span className="max-w-64 truncate text-xs font-normal text-muted-foreground">{c.detail}</span> : null}
                </span>
                <Plus aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No {noun} matches “{query.trim()}”.</p>
      )}
      {searchable && !q && available.length > SHOWN_MATCHES ? (
        <p className="text-xs text-muted-foreground">Showing {SHOWN_MATCHES} of {available.length}. Type to find others.</p>
      ) : null}
    </div>
  );
});
