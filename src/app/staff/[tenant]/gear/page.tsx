import Link from "next/link";
import { ImageOff, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, gearListHref, isDefaultGearList, parseGearListParams, rangeText } from "@/lib/lists";
import { formatCents } from "@/lib/money";

const SEARCHED = ["name", "description"] as const;

/** The gear catalog: active items by default, searchable by name or description, all in the URL. Read-only. */
export default async function GearList({ params, searchParams }: PageProps<"/staff/[tenant]/gear">) {
  const { tenant: slug } = await params;
  const p = parseGearListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/gear`;
  const from = (p.page - 1) * PAGE_SIZE;

  // One page of matches (with the total), how many archived items the
  // filter left out, and whether the business has any gear at all.
  let rowsQuery = supabase
    .from("gear_items")
    .select("id, name, description, default_price_cents, unit_label, active, thumb:gear_media(storage_path), media:gear_media(count)", { count: "exact" })
    .eq("tenant_id", tenant.id)
    .eq("thumb.active", true)
    .eq("thumb.kind", "image")
    .order("sort_order", { referencedTable: "thumb" })
    .order("created_at", { referencedTable: "thumb" })
    .limit(1, { referencedTable: "thumb" })
    .eq("media.active", true);
  let archivedQuery = supabase.from("gear_items").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("active", false);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(SEARCHED, p.q));
    archivedQuery = archivedQuery.or(containsFilter(SEARCHED, p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived, any] = await Promise.all([
    rowsQuery.order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("gear_items").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
  ]);
  if (rows.error || archived.error || any.error) throw new Error("The gear list couldn't be loaded.");
  const items = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;

  // Short-lived signed thumbnails, issued to this staff user only.
  const paths = items.flatMap((g) => g.thumb.map((t) => t.storage_path));
  const { data: signed } = paths.length
    ? await supabase.storage.from("gear-media").createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  return (
    <>
      <PageHeader
        title="Gear"
        description="Items you offer on proposals. Changes apply to new proposals; sent ones keep their own copy."
        actions={
          <Link className={buttonVariants()} href={`${base}/new`}>
            <Plus aria-hidden />
            Add gear
          </Link>
        }
      />
      <ListFilters label="Filter gear" query={p.q} placeholder="Name or description" clearHref={base} showClear={!isDefaultGearList(p)}>
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {total > 0 ? (
        <>
          <ResultLine>
            {total} {p.archived ? "" : "active "}item{total === 1 ? "" : "s"}, by name.
            {total > items.length ? ` ${rangeText(p.page, items.length, total)}.` : null}
            {archivedExcluded > 0 ? (
              <>
                {" "}{archivedExcluded} archived {archivedExcluded === 1 ? "item also matches" : "items also match"}.{" "}
                <Link className="underline" href={gearListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Gear" testId="gear-list">
            {items.map((g) => {
              const thumb = g.thumb[0] ? urlFor.get(g.thumb[0].storage_path) : undefined;
              const mediaCount = g.media[0]?.count ?? 0;
              return (
                <li key={g.id} data-testid="gear-row">
                  <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                    <span className="row-span-2 flex size-14 items-center justify-center overflow-hidden rounded-lg bg-muted sm:row-span-1">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                        <img src={thumb} alt="" loading="lazy" decoding="async" className="size-full object-cover" data-testid="gear-thumb" />
                      ) : (
                        <span data-testid="gear-no-photo">
                          <ImageOff aria-hidden className="size-5 text-muted-foreground" />
                          <span className="sr-only">No photo</span>
                        </span>
                      )}
                    </span>
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <Link className="truncate font-medium underline-offset-4 hover:underline" href={`${base}/${g.id}`}>{g.name}</Link>
                        {g.active ? null : <Badge variant="secondary">Archived</Badge>}
                      </span>
                      {g.description ? <span className="line-clamp-1 text-muted-foreground">{g.description}</span> : null}
                      <span className="text-xs text-muted-foreground">
                        {mediaCount === 0 ? "No photos or videos" : `${mediaCount} photo${mediaCount === 1 ? "" : "s"} or video${mediaCount === 1 ? "" : "s"}`}
                      </span>
                    </span>
                    <span className="col-start-2 grid sm:col-start-3 sm:justify-items-end sm:text-right" data-testid="gear-price">
                      <span className="font-medium">{formatCents(g.default_price_cents, tenant.currency)}</span>
                      <span className="text-xs text-muted-foreground">unit price, per {g.unit_label}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => gearListHref(base, { ...p, page: n })} />
        </>
      ) : (any.count ?? 0) === 0 ? (
        <EmptyList testId="gear-empty">
          <p>No gear yet. Add the items you offer, such as speakers, microphones or lighting.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Add your first item</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="gear-no-results">
          <p>
            {p.q ? "No gear matches this search." : "No active gear."}
            {archivedExcluded > 0 ? ` ${archivedExcluded} archived ${archivedExcluded === 1 ? "item matches" : "items match"} but ${archivedExcluded === 1 ? "is" : "are"} hidden.` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {archivedExcluded > 0 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={gearListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link> : null}
            {!isDefaultGearList(p) ? <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={base}>Clear filters</Link> : null}
          </div>
        </EmptyList>
      )}
    </>
  );
}
