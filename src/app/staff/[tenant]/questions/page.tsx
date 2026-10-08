import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { answerTypeLabel, canHaveRules } from "@/lib/catalog/rules";
import { PAGE_SIZE, containsFilter, isDefaultPackageList, packageListHref, parsePackageListParams, rangeText } from "@/lib/lists";

/** The questions clients answer and the rules that use the answers: active by default, searchable, all in the URL. Read-only. */
export default async function Questions({ params, searchParams }: PageProps<"/staff/[tenant]/questions">) {
  const { tenant: slug } = await params;
  const p = parsePackageListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/questions`;
  const from = (p.page - 1) * PAGE_SIZE;

  let rowsQuery = supabase
    .from("logistics_questions")
    .select("id, prompt, answer_type, required, active, logistics_rules(active, gear_items(active)), proposal_template_questions(template_id)", { count: "exact" })
    .eq("tenant_id", tenant.id);
  let archivedQuery = supabase.from("logistics_questions").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("active", false);
  if (p.q) {
    rowsQuery = rowsQuery.or(containsFilter(["prompt"], p.q));
    archivedQuery = archivedQuery.or(containsFilter(["prompt"], p.q));
  }
  if (!p.archived) rowsQuery = rowsQuery.eq("active", true);
  const [rows, archived, any] = await Promise.all([
    rowsQuery.order("sort_order").order("prompt").order("id").range(from, from + PAGE_SIZE - 1),
    p.archived ? Promise.resolve({ count: 0, error: null }) : archivedQuery,
    supabase.from("logistics_questions").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
  ]);
  if (rows.error || archived.error || any.error) throw new Error("The questions couldn't be loaded.");
  const questions = rows.data;
  const total = rows.count ?? 0;
  const archivedExcluded = archived.count ?? 0;

  return (
    <>
      <PageHeader
        title="Questions & rules"
        description="Questions clients answer on proposals, and the rules that turn answers into required gear (a separate ceremony space needs its own speaker)."
        actions={
          <Link className={buttonVariants()} href={`${base}/new`}>
            <Plus aria-hidden />
            Add question
          </Link>
        }
      />
      <ListFilters label="Filter questions" query={p.q} placeholder="Question" clearHref={base} showClear={!isDefaultPackageList(p)}>
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {total > 0 ? (
        <>
          <ResultLine>
            {total} {p.archived ? "" : "active "}question{total === 1 ? "" : "s"}, in display order.
            {total > questions.length ? ` ${rangeText(p.page, questions.length, total)}.` : null}
            {archivedExcluded > 0 ? (
              <>
                {" "}{archivedExcluded} archived {archivedExcluded === 1 ? "question also matches" : "questions also match"}.{" "}
                <Link className="underline" href={packageListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Questions" testId="question-list">
            {questions.map((q) => {
              const activeRules = q.logistics_rules.filter((r) => r.active);
              const archivedGear = activeRules.some((r) => r.gear_items && !r.gear_items.active);
              const templates = q.proposal_template_questions.length;
              return (
                <li key={q.id} data-testid="question-row">
                  <div className="grid gap-y-1 px-4 py-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link className="font-medium underline-offset-4 [overflow-wrap:anywhere] hover:underline" href={`${base}/${q.id}`}>{q.prompt}</Link>
                      {q.active ? null : <Badge variant="secondary">Archived</Badge>}
                    </span>
                    <span className="text-xs text-muted-foreground" data-testid="question-summary">
                      {answerTypeLabel(q.answer_type)} · {q.required ? "Required" : "Optional"} ·{" "}
                      {canHaveRules(q.answer_type) ? (activeRules.length === 0 ? "no rules" : `${activeRules.length} rule${activeRules.length === 1 ? "" : "s"}`) : "can't have rules"} ·{" "}
                      {templates === 0 ? "in no template" : `in ${templates} template${templates === 1 ? "" : "s"}`}
                    </span>
                    {archivedGear ? <span className="text-xs text-amber-800 dark:text-amber-300">Needs attention: a rule requires archived gear</span> : null}
                  </div>
                </li>
              );
            })}
          </ListRows>
          <Pagination page={p.page} total={total} pageSize={PAGE_SIZE} href={(n) => packageListHref(base, { ...p, page: n })} />
        </>
      ) : (any.count ?? 0) === 0 ? (
        <EmptyList testId="questions-empty">
          <p>No questions yet. Ask what changes the gear you bring, like where the ceremony takes place.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Add your first question</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="questions-no-results">
          <p>
            {p.q ? "No questions match this search." : "No active questions."}
            {archivedExcluded > 0 ? ` ${archivedExcluded} archived ${archivedExcluded === 1 ? "question matches" : "questions match"} but ${archivedExcluded === 1 ? "is" : "are"} hidden.` : null}
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
