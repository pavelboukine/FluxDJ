import Link from "next/link";
import { Info, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, isDefaultPackageList, packageListHref, parsePackageListParams, rangeText } from "@/lib/lists";
import { UsageBadge } from "./usage-badge";

/** The business's contract templates: active by default, searchable by name, all in the URL. */
export default async function ContractTemplates({ params, searchParams }: PageProps<"/staff/[tenant]/contract-templates">) {
  const { tenant: slug } = await params;
  const p = parsePackageListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/contract-templates`;
  const from = (p.page - 1) * PAGE_SIZE;

  let rowsQuery = supabase
    .from("contract_templates")
    .select("id, name, active, contract_template_versions!contract_template_versions_template_fk(version_number, published_at, usage)", { count: "exact" })
    .eq("tenant_id", tenant.id);
  let archivedQuery = supabase.from("contract_templates").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("active", false);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(["name"], p.q));
    archivedQuery = archivedQuery.or(containsFilter(["name"], p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived] = await Promise.all([
    rowsQuery.order("active", { ascending: false }).order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
  ]);
  if (rows.error || archived.error) throw new Error("The contract templates couldn't be loaded.");
  const templates = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;

  return (
    <>
      <PageHeader
        title="Contract templates"
        description="The agreements your clients sign. Write one, copy one or import your Word document, then publish it."
        actions={
          <Link className={buttonVariants()} href={`${base}/new`}>
            <Plus aria-hidden />
            Create template
          </Link>
        }
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Contracts are generated from a template&apos;s published version. Published versions never change, and contracts already generated keep
        their text. You are responsible for your agreement; Flux DJ does not review it.
      </p>

      {total > 0 || p.q || p.archived || archivedExcluded > 0 ? (
        <ListFilters label="Filter contract templates" query={p.q} placeholder="Template name" clearHref={base} showClear={!isDefaultPackageList(p)}>
          <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
        </ListFilters>
      ) : null}

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
          <ListRows label="Contract templates" testId="contract-template-list">
            {templates.map((t) => {
              const versions = [...t.contract_template_versions].sort((a, b) => b.version_number - a.version_number);
              const current = versions.find((v) => v.published_at);
              const draft = versions.find((v) => !v.published_at);
              return (
                <li key={t.id} data-testid="contract-template-row">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm">
                    <div className="grid min-w-0 flex-1 gap-y-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <Link className="font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline" href={`${base}/${t.id}`}>{t.name}</Link>
                        {t.active ? null : <Badge variant="secondary">Archived</Badge>}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {current ? (
                          <>
                            <span>Version {current.version_number} published</span>
                            <UsageBadge usage={current.usage} />
                          </>
                        ) : (
                          <span>Not published yet</span>
                        )}
                        {draft ? <Badge variant="secondary">Draft version {draft.version_number}</Badge> : null}
                      </span>
                    </div>
                    <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${base}/${t.id}`} aria-label={`Open ${t.name}`}>
                      Open
                    </Link>
                  </div>
                </li>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => packageListHref(base, { ...p, page: n })} />
        </>
      ) : !p.q && !p.archived && archivedExcluded === 0 ? (
        <EmptyList testId="contract-templates-empty">
          <p>No contract templates yet.</p>
          <p>Import the agreement you already use in Word, or write one here. You can review everything before publishing it.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Create your first template</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="contract-templates-no-results">
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
