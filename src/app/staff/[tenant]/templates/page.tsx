import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, isDefaultPackageList, packageListHref, parsePackageListParams, rangeText } from "@/lib/lists";

const SEARCHED = ["name", "intro"] as const;

/** The business's proposal templates: active by default, searchable by name or intro, all in the URL. Read-only. */
export default async function Templates({ params, searchParams }: PageProps<"/staff/[tenant]/templates">) {
  const { tenant: slug } = await params;
  const p = parsePackageListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/templates`;
  const from = (p.page - 1) * PAGE_SIZE;

  let rowsQuery = supabase
    .from("proposal_templates")
    .select(
      "id, name, intro, active, default_package_id, proposal_template_packages!proposal_template_packages_template_fk(sort_order, packages!proposal_template_packages_package_fk(id, name, active)), proposal_template_questions(logistics_questions(active)), proposal_template_addons(gear_items(active))",
      { count: "exact" },
    )
    .eq("tenant_id", tenant.id);
  let archivedQuery = supabase.from("proposal_templates").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("active", false);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(SEARCHED, p.q));
    archivedQuery = archivedQuery.or(containsFilter(SEARCHED, p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived, any] = await Promise.all([
    rowsQuery.order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("proposal_templates").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
  ]);
  if (rows.error || archived.error || any.error) throw new Error("The proposal templates couldn't be loaded.");
  const templates = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;

  return (
    <>
      <PageHeader
        title="Proposal templates"
        description="Starting points for proposals: three packages, a recommended one, questions and optional extras."
        actions={
          <Link className={buttonVariants()} href={`${base}/new`}>
            <Plus aria-hidden />
            Add template
          </Link>
        }
      />
      <ListFilters label="Filter proposal templates" query={p.q} placeholder="Name or intro" clearHref={base} showClear={!isDefaultPackageList(p)}>
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {total > 0 ? (
        <>
          <ResultLine>
            {total} {p.archived ? "" : "active "}template{total === 1 ? "" : "s"}, by name.
            {total > templates.length ? ` ${rangeText(p.page, templates.length, total)}.` : null}
            {archivedExcluded > 0 ? (
              <>
                {" "}{archivedExcluded} archived {archivedExcluded === 1 ? "template also matches" : "templates also match"}.{" "}
                <Link className="underline" href={packageListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Proposal templates" testId="template-list">
            {templates.map((t) => {
              const offered = [...t.proposal_template_packages].sort((a, b) => a.sort_order - b.sort_order).flatMap((x) => (x.packages ? [x.packages] : []));
              const flags = [
                offered.length !== 3 ? `${offered.length} of 3 packages` : null,
                offered.length > 0 && !t.default_package_id ? "no recommended package" : null,
                offered.some((x) => !x.active) ? "archived package" : null,
                t.proposal_template_questions.some((q) => q.logistics_questions && !q.logistics_questions.active) ? "archived question" : null,
                t.proposal_template_addons.some((a) => a.gear_items && !a.gear_items.active) ? "archived extra" : null,
              ].filter(Boolean);
              return (
                <li key={t.id} data-testid="template-row">
                  <div className="grid gap-y-1 px-4 py-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link className="truncate font-medium underline-offset-4 hover:underline" href={`${base}/${t.id}`}>{t.name}</Link>
                      {t.active ? null : <Badge variant="secondary">Archived</Badge>}
                    </span>
                    {t.intro ? <span className="line-clamp-1 text-muted-foreground">{t.intro}</span> : null}
                    <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="template-packages-summary">
                      {offered.length > 0
                        ? offered.map((x, i) => (
                            <span key={x.id}>
                              {i > 0 ? " · " : null}
                              {x.name}
                              {x.id === t.default_package_id ? " (recommended)" : null}
                            </span>
                          ))
                        : "No packages yet"}
                      {" · "}
                      {t.proposal_template_questions.length} question{t.proposal_template_questions.length === 1 ? "" : "s"}
                    </span>
                    {flags.length > 0 ? (
                      <span className="text-xs text-amber-800 dark:text-amber-300" data-testid="template-flags">Needs attention: {flags.join(", ")}</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => packageListHref(base, { ...p, page: n })} />
        </>
      ) : (any.count ?? 0) === 0 ? (
        <EmptyList testId="templates-empty">
          <p>No proposal templates yet. A template is the quickest way to start proposals: choose three packages once and reuse them.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Add your first template</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="templates-no-results">
          <p>
            {p.q ? "No templates match this search." : "No active templates."}
            {archivedExcluded > 0 ? ` ${archivedExcluded} archived ${archivedExcluded === 1 ? "template matches" : "templates match"} but ${archivedExcluded === 1 ? "is" : "are"} hidden.` : null}
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
