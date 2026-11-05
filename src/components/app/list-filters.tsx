"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fieldClass, filterHeight } from "./list";

/**
 * The filter bar of the staff list pages: a plain GET form, so search,
 * filters and page live in the URL and it works without JavaScript; selects
 * and checkboxes apply as soon as they change. Below md the search stays in
 * view and everything else folds behind a Filters button, with the filters in
 * use named under it so they are never hidden. From md all controls are inline.
 */
export function ListFilters({
  label,
  query,
  placeholder,
  clearHref,
  showClear,
  defaults = {},
  active = [],
  children,
  more,
}: {
  /** Accessible name of the filter form. */
  label: string;
  query: string;
  placeholder: string;
  clearHref: string;
  showClear: boolean;
  /** Values that are the list's default (left out of the URL), e.g. { view: "upcoming" }. */
  defaults?: Record<string, string>;
  /** The filters in use, in words (not the search text): their count and names show when the controls are folded. */
  active?: string[];
  /** Extra filters (selects and checkboxes); they submit the form when changed. */
  children?: ReactNode;
  /** Less-used filters, shown after the buttons (e.g. a MoreFilters disclosure). */
  more?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <form
      ref={form}
      method="get"
      // With JavaScript, the URL keeps only values that differ from the defaults (and starts at page 1).
      onSubmit={(e) => {
        e.preventDefault();
        const params = new URLSearchParams();
        for (const [key, value] of new FormData(e.currentTarget)) {
          if (typeof value === "string" && value.trim() !== "" && defaults[key] !== value) params.set(key, value.trim());
        }
        const qs = params.toString();
        router.push(qs ? `${pathname}?${qs}` : pathname);
      }}
      role="search"
      aria-label={label}
      className="flex flex-wrap items-end gap-2"
      onChange={(e) => {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === "checkbox")) form.current?.requestSubmit();
      }}
    >
      <label className="grid min-w-0 flex-1 basis-40 gap-1 text-xs font-medium text-muted-foreground md:basis-56">
        <span className="max-md:sr-only">Search</span>
        <span className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input key={query} type="search" name="q" defaultValue={query} maxLength={100} placeholder={placeholder} className={cn(fieldClass, filterHeight, "w-full pl-8 text-foreground")} />
        </span>
      </label>
      <Button type="button" variant="outline" className="h-11 md:hidden" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal aria-hidden />
        Filters
        {active.length > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground" data-testid="active-filter-count">
            {active.length}<span className="sr-only"> active</span>
          </span>
        ) : null}
        <ChevronDown aria-hidden className={cn("transition-transform", open ? "rotate-180" : null)} />
      </Button>
      {active.length > 0 || showClear ? (
        <div className="flex basis-full flex-wrap items-center justify-between gap-x-3 text-sm md:hidden" data-testid="active-filters">
          {active.length > 0 ? <p className="min-w-0 text-muted-foreground">{active.join(" · ")}</p> : null}
          {showClear ? <Link className={cn(buttonVariants({ variant: "ghost" }), "-mr-2.5 ml-auto")} href={clearHref}>Clear filters</Link> : null}
        </div>
      ) : null}
      <div id={panelId} data-filter-panel className={cn(open ? "flex basis-full flex-wrap items-end gap-2" : "hidden", "md:contents")}>
        {children}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="outline" className={filterHeight}>Search</Button>
          {showClear ? (
            <Link className={cn(buttonVariants({ variant: "ghost" }), "h-9 max-md:hidden")} href={clearHref}>Clear filters</Link>
          ) : null}
        </div>
        {more}
      </div>
      {/* Without JavaScript the button can't open the panel, so it stays open. */}
      <noscript>
        <style>{"[data-filter-panel]{display:flex;flex-wrap:wrap;gap:.5rem;flex-basis:100%}"}</style>
      </noscript>
    </form>
  );
}

