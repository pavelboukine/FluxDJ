import type { ReactNode } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Shared pieces of the staff list pages (Events, Clients): filters (with
 * ListFilters in ./list-filters), a result line, stacked rows, empty states
 * and pagination.
 */

export const fieldClass =
  "h-9 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function FilterSelect({ label, name, value, options }: { label: string; name: string; value: string; options: readonly (readonly [string, string])[] }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select name={name} defaultValue={value} className={cn(fieldClass, "min-w-36 text-foreground")}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

export function FilterCheckbox({ label, name, checked }: { label: string; name: string; checked: boolean }) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg px-1 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={checked} className="size-4 accent-primary" />
      {label}
    </label>
  );
}

/** "12 events · 3 archived events also match (hidden)." with a link to include them. */
export function ResultLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground" data-testid="list-result">{children}</p>;
}

export function ListRows({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <ul aria-label={label} data-testid={testId} className="divide-y overflow-hidden rounded-xl border bg-card">
      {children}
    </ul>
  );
}

export function EmptyList({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="grid justify-items-start gap-2 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Pagination({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      {page > 1 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href(page - 1)} rel="prev">Previous</Link> : <span />}
      <span className="text-muted-foreground">Page {Math.min(page, pages)} of {pages}</span>
      {page < pages ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href(page + 1)} rel="next">Next</Link> : <span />}
    </nav>
  );
}
