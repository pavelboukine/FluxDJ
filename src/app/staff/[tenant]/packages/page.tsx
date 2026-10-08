import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, includedGearSummary, isDefaultPackageList, packageListHref, parsePackageListParams, rangeText } from "@/lib/lists";
import { formatCents } from "@/lib/money";

const SEARCHED = ["name", "description"] as const;

/** The business's packages: active by default, searchable by name or description, all in the URL. Read-only. */
export default async function PackageList({ params, searchParams }: PageProps<"/staff/[tenant]/packages">) {
  const { tenant: slug } = await params;
  const p = parsePackageListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/packages`;
  const from = (p.page - 1) * PAGE_SIZE;

  // One page of matches (with the total), how many archived packages the
  // filter left out, and whether the business has any packages at all.
  let rowsQuery = supabase
    .from("packages")
    .select("id, name, description, base_price_cents, active, package_items(quantity, gear_items!package_items_gear_item_fk(name, active))", { count: "exact" })
    .eq("tenant_id", tenant.id);
  let archivedQuery = supabase.from("packages").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("active", false);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(SEARCHED, p.q));
    archivedQuery = archivedQuery.or(containsFilter(SEARCHED, p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived, any] = await Promise.all([
    rowsQuery.order("sort_order").order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("packages").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
  ]);
  if (rows.error || archived.error || any.error) throw new Error("The packages list couldn't be loaded.");
  const packages = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;

  return (
    <>
      <PageHeader
        title="Packages"
        description="What proposals offer: each proposal shows three packages. Changes apply to new proposals; sent ones keep their own copy."
        actions={
          <Link className={buttonVariants()} href={`${base}/new`}>
            <Plus aria-hidden />
            Add package
          </Link>
        }
      />
      <ListFilters label="Filter packages" query={p.q} placeholder="Name or description" clearHref={base} showClear={!isDefaultPackageList(p)}>
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {total > 0 ? (
        <>
          <ResultLine>
            {total} {p.archived ? "" : "active "}package{total === 1 ? "" : "s"}, in display order.
            {total > packages.length ? ` ${rangeText(p.page, packages.length, total)}.` : null}
            {archivedExcluded > 0 ? (
              <>
                {" "}{archivedExcluded} archived {archivedExcluded === 1 ? "package also matches" : "packages also match"}.{" "}
                <Link className="underline" href={packageListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Packages" testId="package-list">
            {packages.map((pk) => {
              const items = pk.package_items.flatMap((i) => (i.gear_items ? [{ name: i.gear_items.name, quantity: i.quantity, active: i.gear_items.active }] : []));
              const archivedGear = items.filter((i) => !i.active).length;
              return (
                <li key={pk.id} data-testid="package-row">
                  <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <Link className="truncate font-medium underline-offset-4 hover:underline" href={`${base}/${pk.id}`}>{pk.name}</Link>
                        {pk.active ? null : <Badge variant="secondary">Archived</Badge>}
                      </span>
                      {pk.description ? <span className="line-clamp-1 text-muted-foreground">{pk.description}</span> : null}
                      <span className="text-xs text-muted-foreground" data-testid="package-gear">
                        {includedGearSummary(items)}
                        {archivedGear > 0 ? <span className="text-amber-800 dark:text-amber-300"> · {archivedGear} archived gear item{archivedGear === 1 ? "" : "s"}</span> : null}
                      </span>
                    </span>
                    <span className="grid sm:justify-items-end sm:text-right" data-testid="package-price">
                      <span className="font-medium">{formatCents(pk.base_price_cents, tenant.currency)}</span>
                      <span className="text-xs text-muted-foreground">base price, before tax</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => packageListHref(base, { ...p, page: n })} />
        </>
      ) : (any.count ?? 0) === 0 ? (
        <EmptyList testId="packages-empty">
          <p>No packages yet. Each proposal offers three, so most businesses start with three.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Add your first package</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="packages-no-results">
          <p>
            {p.q ? "No packages match this search." : "No active packages."}
            {archivedExcluded > 0 ? ` ${archivedExcluded} archived ${archivedExcluded === 1 ? "package matches" : "packages match"} but ${archivedExcluded === 1 ? "is" : "are"} hidden.` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {archivedExcluded > 0 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={packageListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link> : null}
            {!isDefaultPackageList(p) ? <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={base}>Clear filters</Link> : null}
          </div>
        </EmptyList>
      )}
    </>
  );
}
