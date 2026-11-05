import Link from "@/components/app/pending-link";
import { ImageOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, FilterSelect, INCLUDING_ARCHIVED, ListAction, ListRow, ListRows, NoResults, Pagination, ResultLine, RowLink, activeLabels } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, gearListHref, isDefaultGearList, parseGearListParams, rangeText } from "@/lib/lists";
import { formatCents } from "@/lib/money";
import { UNCATEGORIZED } from "@/lib/catalog/categories";
import { perUnitText } from "@/lib/catalog/quantity";
import { SetupReturn } from "@/components/app/setup-return";
import { CategoryManager } from "./category-manager";

const SEARCHED = ["name", "description"] as const;

/**
 * The gear catalog: active items by default, searchable by name or
 * description and filtered by category, all in the URL; plus the business's
 * categories (add, rename, order, delete).
 */
export default async function GearList({ params, searchParams }: PageProps<"/staff/[tenant]/gear">) {
  const { tenant: slug } = await params;
  const query = await searchParams;
  const p = parseGearListParams(query);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/gear`;
  const from = (p.page - 1) * PAGE_SIZE;

  // One page of matches (with the total), how many archived items the
  // filter left out, and whether the business has any gear at all.
  let rowsQuery = supabase
    .from("gear_items")
    .select(
      "id, name, description, default_price_cents, unit_label, pieces_per_unit, piece_label, active, category:gear_categories!gear_items_category_fk(name), thumb:gear_media(storage_path), media:gear_media(count)",
      { count: "exact" },
    )
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
  if (p.category === "none") {
    rowsQuery = rowsQuery.is("category_id", null);
    archivedQuery = archivedQuery.is("category_id", null);
  } else if (p.category) {
    rowsQuery = rowsQuery.eq("category_id", p.category);
    archivedQuery = archivedQuery.eq("category_id", p.category);
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived, any, categories] = await Promise.all([
    rowsQuery.order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("gear_items").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("gear_categories").select("id, name, sort_order, gear:gear_items!gear_items_category_fk(count)").eq("tenant_id", tenant.id).order("sort_order").order("name"),
  ]);
  if (rows.error || archived.error || any.error || categories.error) throw new Error("The gear list couldn't be loaded.");
  const categoryList = categories.data.map((c) => ({ id: c.id, name: c.name, items: c.gear[0]?.count ?? 0 }));
  const items = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;
  const none = (any.count ?? 0) === 0;
  const categoryName = p.category === "none" ? UNCATEGORIZED : categoryList.find((c) => c.id === p.category)?.name;

  // Short-lived signed thumbnails, issued to this staff user only.
  const paths = items.flatMap((g) => g.thumb.map((t) => t.storage_path));
  const { data: signed } = paths.length
    ? await supabase.storage.from("gear-media").createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));

  return (
    <>
      <SetupReturn slug={slug} from={query.from} />
      <PageHeader
        title="Gear"
        description="Items you offer on proposals. Changes apply to new proposals; sent ones keep their own copy."
        hideDescriptionOnPhone={!none}
        actions={none ? null : <ListAction href={`${base}/new`}>Add gear</ListAction>}
      />
      {none ? null : (
        <ListFilters
          label="Filter gear"
          query={p.q}
          placeholder="Name or description"
          clearHref={base}
          showClear={!isDefaultGearList(p)}
          active={activeLabels(p.category && categoryName && `Category: ${categoryName}`, p.archived && INCLUDING_ARCHIVED)}
        >
          {categoryList.length > 0 ? (
            <FilterSelect
              label="Category"
              name="category"
              value={p.category}
              options={[["", "All categories"], ...categoryList.map((c) => [c.id, c.name] as const), ["none", UNCATEGORIZED]]}
            />
          ) : null}
          <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
        </ListFilters>
      )}

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
                <ListRow key={g.id} testId="gear-row" className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                  <span className={`row-span-2 flex size-14 items-center justify-center overflow-hidden rounded-lg sm:row-span-1 ${thumb ? "bg-white ring-1 ring-black/5 ring-inset" : "bg-muted"}`}>
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                      <img src={thumb} alt="" loading="lazy" decoding="async" className="size-full object-contain p-0.5" data-testid="gear-thumb" />
                    ) : (
                      <span data-testid="gear-no-photo">
                        <ImageOff aria-hidden className="size-5 text-muted-foreground" />
                        <span className="sr-only">No photo</span>
                      </span>
                    )}
                  </span>
                  <span className="grid min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <RowLink className="truncate" href={`${base}/${g.id}`}>{g.name}</RowLink>
                      {g.active ? null : <Badge variant="secondary">Archived</Badge>}
                    </span>
                    {categoryList.length > 0 ? (
                      <span className="text-xs font-medium text-muted-foreground" data-testid="gear-category">{g.category?.name ?? UNCATEGORIZED}</span>
                    ) : null}
                    {g.description ? <span className="line-clamp-1 text-muted-foreground">{g.description}</span> : null}
                    <span className="text-xs text-muted-foreground">
                      {mediaCount === 0 ? "No photos or videos" : `${mediaCount} photo${mediaCount === 1 ? "" : "s"} or video${mediaCount === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="col-start-2 grid sm:col-start-3 sm:justify-items-end sm:text-right" data-testid="gear-price">
                    <span className="font-medium">{formatCents(g.default_price_cents, tenant.currency)}</span>
                    <span className="text-xs text-muted-foreground">unit price, {perUnitText(g)}</span>
                  </span>
                </ListRow>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => gearListHref(base, { ...p, page: n })} />
        </>
      ) : none ? (
        <EmptyList testId="gear-empty" title="No gear yet." actions={<ListAction href={`${base}/new`}>Add gear</ListAction>}>
          Add the items you offer, such as speakers, microphones or lighting.
        </EmptyList>
      ) : (
        <NoResults
          testId="gear-no-results"
          title={p.q ? "No gear matches this search." : p.category ? "No gear in this category." : "No active gear."}
          noun={["item", "items"]}
          archived={archivedExcluded}
          includeArchivedHref={gearListHref(base, { ...p, archived: true, page: 1 })}
          clearHref={isDefaultGearList(p) ? null : base}
        />
      )}
      <CategoryManager slug={slug} categories={categoryList} />
    </>
  );
}
