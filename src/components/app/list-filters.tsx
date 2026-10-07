"use client";

import { useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fieldClass } from "./list";

/**
 * The filter bar of the staff list pages: a plain GET form, so search,
 * filters and page live in the URL and it works without JavaScript; selects
 * and checkboxes apply as soon as they change.
 */
export function ListFilters({
  label,
  query,
  placeholder,
  clearHref,
  showClear,
  defaults = {},
  children,
}: {
  /** Accessible name of the filter form. */
  label: string;
  query: string;
  placeholder: string;
  clearHref: string;
  showClear: boolean;
  /** Values that are the list's default (left out of the URL), e.g. { view: "upcoming" }. */
  defaults?: Record<string, string>;
  /** Extra filters (selects and checkboxes); they submit the form when changed. */
  children?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const pathname = usePathname();
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
      <label className="grid min-w-0 flex-1 basis-56 gap-1 text-xs font-medium text-muted-foreground">
        Search
        <span className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input key={query} type="search" name="q" defaultValue={query} maxLength={100} placeholder={placeholder} className={cn(fieldClass, "w-full pl-8 text-foreground")} />
        </span>
      </label>
      {children}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="outline" className="h-9">Search</Button>
        {showClear ? (
          <Link className={cn(buttonVariants({ variant: "ghost" }), "h-9")} href={clearHref}>Clear filters</Link>
        ) : null}
      </div>
    </form>
  );
}

