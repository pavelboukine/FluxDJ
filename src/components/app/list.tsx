import type { ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import Link from "@/components/app/pending-link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Shared pieces of the staff list pages: the primary action, filters (with
 * ListFilters in ./list-filters), a result line, rows, empty states and
 * pagination.
 */

/** An outline button as a link. Merged, because the raw variant string leaves its border transparent. */
export const outlineLink = cn(buttonVariants({ variant: "outline" }), "text-foreground");

/** A list page's one primary action. "Add" for an entry (client, gear, question), "Create" for what you build here (event, package, template). */
export function ListAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={buttonVariants()} href={href}>
      <Plus aria-hidden className="max-md:hidden" />
      {children}
    </Link>
  );
}

/** Text at least 16px on phones, so iOS never zooms on focus. */
export const fieldClass =
  "h-9 rounded-lg border border-input bg-background px-2.5 text-base outline-none md:text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Filter bar controls: 44px on phones, compact from md. */
export const filterHeight = "h-11 md:h-9";

export function FilterSelect({ label, name, value, options }: { label: string; name: string; value: string; options: readonly (readonly [string, string])[] }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground max-md:flex-1">
      {label}
      <select key={value} name={name} defaultValue={value} className={cn(fieldClass, filterHeight, "min-w-36 text-foreground")}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

export function FilterDate({ label, name, value }: { label: string; name: string; value: string | null }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground max-md:flex-1">
      {label}
      <input key={value ?? ""} type="date" name={name} defaultValue={value ?? ""} className={cn(fieldClass, filterHeight, "min-w-36 text-foreground")} />
    </label>
  );
}

/**
 * Filters most visits don't need, folded away (native details: keyboard
 * friendly, no JavaScript) and open whenever one of them is in use.
 */
export function MoreFilters({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group basis-full">
      <summary className="inline-flex min-h-11 cursor-pointer md:min-h-9 items-center rounded-lg px-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        More filters
      </summary>
      <div className="flex flex-wrap items-end gap-2 pt-2">{children}</div>
    </details>
  );
}

export function FilterCheckbox({ label, name, checked }: { label: string; name: string; checked: boolean }) {
  return (
    <label className={cn(filterHeight, "flex items-center gap-2 rounded-lg px-1 text-sm")}>
      <input key={String(checked)} type="checkbox" name={name} value="1" defaultChecked={checked} className="size-4 accent-primary" />
      {label}
    </label>
  );
}

/** "12 events · 3 archived events also match (hidden)." with a link to include them. */
export function ResultLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground" data-testid="list-result">{children}</p>;
}

/** The human-readable filters in use (other than the search text), shown when the controls are folded away. */
export const activeLabels = (...labels: (string | false | null | undefined)[]) => labels.filter((label): label is string => Boolean(label));
export const optionLabel = (options: readonly (readonly [string, string])[], value: string) => options.find(([v]) => v === value)?.[1] ?? value;
export const INCLUDING_ARCHIVED = "Including archived";

export function ListRows({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <ul aria-label={label} data-testid={testId} className="divide-y overflow-hidden rounded-xl border bg-card">
      {children}
    </ul>
  );
}

/**
 * One row that leads to one place. RowLink's title is the row's link, stretched
 * over the whole row, so the row has one link with a short name and nothing is
 * nested. Something independent inside the row (another link, text to select)
 * goes above it with rowRaised.
 */
export function ListRow({ testId, className, children }: { testId: string; className?: string; children: ReactNode }) {
  return (
    <li
      data-testid={testId}
      className="relative transition-colors hover:bg-muted/50 active:bg-muted has-[[data-row-link]:focus-visible]:ring-3 has-[[data-row-link]:focus-visible]:ring-ring/50 has-[[data-row-link]:focus-visible]:ring-inset"
    >
      <div className={cn("py-3 pr-9 pl-4 text-sm", className)}>{children}</div>
      <ChevronRight aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </li>
  );
}

export function RowLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link data-row-link href={href} className={cn("font-medium outline-none after:absolute after:inset-0 after:content-['']", className)}>
      {children}
    </Link>
  );
}

export const rowRaised = "relative z-10";

/**
 * Nothing to list. Say why in `title`, add guidance as children, and offer one
 * clear next step in `actions`: the page header drops its own action when the
 * business has none of these yet.
 */
export function EmptyList({ title, children, actions, testId }: { title?: ReactNode; children?: ReactNode; actions?: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="grid justify-items-start gap-3 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">
      {title ? (
        <p>
          <span className="block font-medium text-foreground">{title}</span>
          {children ? <> {children}</> : null}
        </p>
      ) : (
        children
      )}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A business that has records, but none to show: a search or filter found nothing, or the matches are archived. */
export function NoResults({
  testId,
  title,
  noun,
  archived,
  includeArchivedHref,
  clearHref,
  children,
  actions,
}: {
  testId: string;
  title: string;
  /** Singular and plural, as in "1 archived item matches". */
  noun: readonly [string, string];
  archived: number;
  includeArchivedHref: string;
  /** Where Clear filters leads; null when no filter is in use. */
  clearHref: string | null;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <EmptyList
      testId={testId}
      title={title}
      actions={
        archived > 0 || clearHref || actions ? (
          <>
            {archived > 0 ? <Link className={outlineLink} href={includeArchivedHref}>Include archived</Link> : null}
            {actions}
            {/* On phones the filter bar's own Clear filters is right above. */}
            {clearHref ? <Link className={cn(outlineLink, "max-md:hidden")} href={clearHref}>Clear filters</Link> : null}
          </>
        ) : null
      }
    >
      {archived > 0 ? `${archived} archived ${archived === 1 ? `${noun[0]} matches` : `${noun[1]} match`} but ${archived === 1 ? "is" : "are"} hidden.` : null}
      {archived > 0 && children ? " " : null}
      {children}
    </EmptyList>
  );
}

export function Pagination({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      {page > 1 ? <Link className={cn(buttonVariants({ variant: "outline", size: "sm" }))} href={href(page - 1)} rel="prev">Previous</Link> : <span />}
      <span className="text-muted-foreground">Page {Math.min(page, pages)} of {pages}</span>
      {page < pages ? <Link className={cn(buttonVariants({ variant: "outline", size: "sm" }))} href={href(page + 1)} rel="next">Next</Link> : <span />}
    </nav>
  );
}
