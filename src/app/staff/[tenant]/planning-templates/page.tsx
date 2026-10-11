import Link from "next/link";
import { Info, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { PAGE_SIZE, containsFilter, isDefaultPackageList, packageListHref, parsePackageListParams, rangeText } from "@/lib/lists";
import { plural, structureCounts } from "@/lib/planning/template-structure";
import { EVENT_TYPES } from "../events/event-form";
import { installStarterTemplates } from "./actions";

const SEARCHED = ["name", "description"] as const;

/** The business's planning templates: active by default, searchable by name or description, all in the URL. */
export default async function PlanningTemplates({ params, searchParams }: PageProps<"/staff/[tenant]/planning-templates">) {
  const { tenant: slug } = await params;
  const p = parsePackageListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/planning-templates`;
  const from = (p.page - 1) * PAGE_SIZE;

  let rowsQuery = supabase
    .from("planning_templates")
    .select("id, name, description, starter_key, default_event_type, archived_at, planning_template_items!planning_template_items_template_fk(kind)", { count: "exact" })
    .eq("tenant_id", tenant.id);
  let archivedQuery = supabase.from("planning_templates").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).not("archived_at", "is", null);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(SEARCHED, p.q));
    archivedQuery = archivedQuery.or(containsFilter(SEARCHED, p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.is("archived_at", null);
  const [rows, archived, starters] = await Promise.all([
    rowsQuery.order("archived_at", { ascending: true, nullsFirst: true }).order("name").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("planning_templates").select("starter_key").eq("tenant_id", tenant.id).not("starter_key", "is", null),
  ]);
  if (rows.error || archived.error || starters.error) throw new Error("The planning templates couldn't be loaded.");
  const templates = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;
  const installed = new Set(starters.data.map((s) => s.starter_key));
  const startersMissing = !installed.has("wedding") || !installed.has("simple_party");
  const typeLabel = new Map<string, string>(EVENT_TYPES);
  const create = (
    <Link className={buttonVariants()} href={`${base}/new`}>
      <Plus aria-hidden />
      Create template
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Planning templates"
        description="The planning structure clients fill in: general sections, then the event's stages and their moments, in order."
        actions={create}
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Each event gets its own copy of a template when its planning starts. Changing a template affects future events only; plans already started don&apos;t change.
      </p>

      {startersMissing ? (
        <section aria-labelledby="starters-heading" className="grid gap-2 rounded-xl border border-dashed p-4 text-sm" data-testid="starter-offer">
          <h2 id="starters-heading" className="font-medium">Wedding and Simple Party starters</h2>
          <p className="text-muted-foreground">
            Ready-made templates to rename, reorder and trim: Wedding (ceremony to closing) and Simple Party (event basics, must play and do not play).
            Only the missing ones are added.
          </p>
          <ActionForm action={installStarterTemplates.bind(null, slug)} submitLabel="Add starter templates" pendingLabel="Adding…" variant="outline">
            <span className="sr-only">Adds the Wedding and Simple Party starters if they are missing.</span>
          </ActionForm>
        </section>
      ) : null}

      {total > 0 || p.q || p.archived || archivedExcluded > 0 ? (
        <ListFilters label="Filter planning templates" query={p.q} placeholder="Name or description" clearHref={base} showClear={!isDefaultPackageList(p)}>
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
          <ListRows label="Planning templates" testId="planning-template-list">
            {templates.map((t) => {
              const c = structureCounts(t.planning_template_items);
              const type = t.default_event_type ? (typeLabel.get(t.default_event_type) ?? t.default_event_type) : null;
              return (
                <li key={t.id} data-testid="planning-template-row">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm">
                    <div className="grid min-w-0 flex-1 gap-y-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <Link className="font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline" href={`${base}/${t.id}`}>{t.name}</Link>
                        {t.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
                        {type ? <Badge variant="outline">Default for {type} events</Badge> : null}
                      </span>
                      {t.description ? <span className="line-clamp-2 text-muted-foreground">{t.description}</span> : null}
                      <span className="text-xs text-muted-foreground">
                        {plural(c.general, "general section")} · {plural(c.stages, "stage")} · {plural(c.moments, "moment")}
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
        <EmptyList testId="planning-templates-empty">
          <p>No planning templates yet.</p>
          <p>
            A template is the plan your clients fill in for an event. Start from the Wedding or Simple Party outline, then make it yours.
          </p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Create your first template</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="planning-templates-no-results">
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
