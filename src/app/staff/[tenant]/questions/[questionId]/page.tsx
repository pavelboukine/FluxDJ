import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "@/components/app/action-form";
import { ArchivePanel } from "@/components/app/archive-panel";
import { PageHeader } from "@/components/app/fields";
import { InlineEditor } from "@/components/app/inline-editor";
import { requireStaff } from "@/lib/auth/staff";
import { answerTypeLabel, canHaveRules, conditionValues, ruleStatement, type QuestionOption } from "@/lib/catalog/rules";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { createRule, setQuestionArchived, setRuleActive, updateQuestion, updateRule } from "../actions";
import { QuestionFields } from "../question-fields";
import { RuleFields, type RuleGearChoice } from "../rule-fields";
import { RuleToggle } from "./rule-toggle";

const LIMIT = 300;

/**
 * One question: what clients are asked (Edit), the templates that ask it,
 * its rules as plain statements (each editable and archivable), adding a
 * rule, and archiving the question.
 */
export default async function QuestionPage({ params, searchParams }: PageProps<"/staff/[tenant]/questions/[questionId]">) {
  const { tenant: slug, questionId } = await params;
  if (!UUID_RE.test(questionId)) notFound();
  const created = (await searchParams).created;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: q } = await supabase
    .from("logistics_questions")
    .select(
      "id, key, prompt, answer_type, options, required, active, sort_order, logistics_rules(id, condition, required_quantity, reason, active, gear_item_id, created_at, gear_items(id, name, active))",
    )
    .eq("id", questionId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!q) notFound();
  const options = (q.options ?? []) as QuestionOption[];
  const rules = [...q.logistics_rules].sort((a, b) => Number(b.active) - Number(a.active) || a.created_at.localeCompare(b.created_at));
  const ruleGearIds = [...new Set(rules.map((r) => r.gear_item_id))];

  const gearSelect = "id, name, active, default_price_cents, unit_label";
  const [activeGear, ruleGear, templates, inclusions] = await Promise.all([
    supabase.from("gear_items").select(gearSelect).eq("tenant_id", tenant.id).eq("active", true).order("name").limit(LIMIT),
    ruleGearIds.length ? supabase.from("gear_items").select(gearSelect).eq("tenant_id", tenant.id).in("id", ruleGearIds) : Promise.resolve({ data: [] as never[], error: null }),
    supabase
      .from("proposal_template_questions")
      .select("sort_order, proposal_templates!proposal_template_questions_template_fk(id, name, active)")
      .eq("tenant_id", tenant.id)
      .eq("question_id", q.id)
      .limit(50),
    ruleGearIds.length
      ? supabase
          .from("package_items")
          .select("gear_item_id, quantity, packages!package_items_package_fk(id, name, active)")
          .eq("tenant_id", tenant.id)
          .in("gear_item_id", ruleGearIds)
      : Promise.resolve({ data: [] as never[], error: null }),
  ]);
  const gearMap = new Map<string, RuleGearChoice>();
  for (const g of [...(ruleGear.data ?? []), ...(activeGear.data ?? [])]) {
    gearMap.set(g.id, { id: g.id, name: g.name, active: g.active, price: formatCents(g.default_price_cents, tenant.currency), unit: g.unit_label });
  }
  const gear = [...gearMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const usedBy = (templates.data ?? []).flatMap((t) => (t.proposal_templates ? [t.proposal_templates] : []));
  const activeTemplates = usedBy.filter((t) => t.active).length;
  const includedIn = (gearId: string) =>
    (inclusions.data ?? []).filter((i) => i.gear_item_id === gearId && i.packages?.active).map((i) => `${i.packages!.name} (${i.quantity})`);
  const inUse: Record<string, number> = {};
  for (const r of rules) for (const v of conditionValues(r.condition)) inUse[v] = (inUse[v] ?? 0) + 1;
  const ruled = canHaveRules(q.answer_type);

  return (
    <>
      <PageHeader
        title={q.prompt}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/questions`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to questions &amp; rules
          </Link>
        }
        actions={q.active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Archived</Badge>}
      />
      {created === "1" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">Question created.{ruled ? " Add its rules below." : ""}</p>
      ) : created === "replayed" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          This question was already saved: an earlier attempt went through, but its reply didn&apos;t arrive.
        </p>
      ) : null}
      {!q.active ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This question is archived. It can&apos;t be added to templates or proposals, and proposals that still ask it can&apos;t be previewed or sent until
          you restore it or remove it there.
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Changes here apply to every proposal previewed or sent from now on that asks this question, including drafts. Sent proposals keep the question,
        answers and prices they were sent with.
      </p>

      <InlineEditor
        id="question"
        title="The question clients answer"
        editLabel="Edit question"
        view={
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Answer type</dt>
              <dd>{answerTypeLabel(q.answer_type)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Answer</dt>
              <dd>{q.required ? "Required: clients can't submit without it" : "Optional: if left blank, its rules don't apply"}</dd>
            </div>
            {options.length > 0 ? (
              <div className="grid gap-0.5 sm:col-span-2">
                <dt className="text-xs font-medium text-muted-foreground">Choices, in order</dt>
                <dd>
                  <ol className="grid list-decimal gap-0.5 pl-5" data-testid="question-choices">
                    {options.map((o) => (
                      <li key={o.value}>
                        {o.label}
                        {inUse[o.value] ? <span className="text-xs text-muted-foreground"> · used by {inUse[o.value] === 1 ? "a rule" : `${inUse[o.value]} rules`}</span> : null}
                      </li>
                    ))}
                  </ol>
                </dd>
              </div>
            ) : null}
            <div className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Display order</dt>
              <dd>{q.sort_order}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Key</dt>
              <dd className="font-mono text-xs">{q.key}</dd>
            </div>
          </dl>
        }
        action={updateQuestion.bind(null, slug, q.id)}
        submitLabel="Save question"
        discardMessage="Discard the changes you made to this question?"
      >
        <QuestionFields question={{ ...q, options }} inUse={inUse} />
      </InlineEditor>

      <section aria-labelledby="templates-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="templates-heading" className="text-base font-semibold">Asked in templates</h2>
          <p className="text-sm text-muted-foreground">Proposals started from these templates ask this question.</p>
        </div>
        {usedBy.length > 0 ? (
          <ul className="grid gap-1 text-sm" data-testid="question-templates">
            {usedBy.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-2">
                <Link className="font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/templates/${t.id}`}>{t.name}</Link>
                {t.active ? null : <Badge variant="secondary">Archived</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No template asks it yet. Add it to a template under Proposal templates.</p>
        )}
      </section>

      <section id="rules" aria-labelledby="rules-heading" className="grid scroll-mt-20 gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="rules-heading" className="text-base font-semibold">Rules</h2>
          <p className="text-sm text-muted-foreground">What the business requires when a client gives a certain answer.</p>
        </div>
        {ruled ? (
          <>
            <div className="grid gap-1 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground" data-testid="rules-explainer">
              <p className="font-medium text-foreground">How required quantities work</p>
              <p>
                When several rules match a client&apos;s answers, their quantities add up for each gear item: two rules requiring 1 speaker each require 2.
                Units the chosen package already includes count toward that total; only the remainder is added to the proposal, at the gear&apos;s unit price.
                If the client also picked that gear as an extra, they&apos;re charged for the larger of the two quantities, not both.
              </p>
            </div>
            {rules.length > 0 ? (
              <ul className="grid gap-3" data-testid="rule-list">
                {rules.map((r, i) => {
                  const statement = ruleStatement(q.prompt, r.condition, options, r.required_quantity, r.gear_items?.name ?? "unavailable gear");
                  const packs = includedIn(r.gear_item_id);
                  return (
                    <li key={r.id} data-testid="rule-item">
                      <InlineEditor
                        id={`rule-${r.id}`}
                        nested
                        title={statement}
                        editLabel="Edit rule"
                        actions={<RuleToggle action={setRuleActive.bind(null, slug, q.id, r.id, !r.active)} active={r.active} label={statement} />}
                        view={
                          <div className="grid gap-1 text-xs text-muted-foreground">
                            <p>Client sees: “{r.reason}”</p>
                            <p>
                              Gear:{" "}
                              {r.gear_items ? (
                                <Link className="underline-offset-4 hover:underline" href={`/staff/${slug}/gear/${r.gear_items.id}`}>{r.gear_items.name}</Link>
                              ) : (
                                "unavailable"
                              )}
                              {packs.length > 0 ? ` · included in ${packs.join(", ")}` : " · not included in any active package"}
                            </p>
                            <span className="flex flex-wrap gap-1">
                              {r.active ? null : <Badge variant="secondary">Archived rule: doesn&apos;t apply</Badge>}
                              {r.active && r.gear_items && !r.gear_items.active ? (
                                <Badge variant="outline" className="border-amber-500/60 text-amber-800 dark:text-amber-300">
                                  Archived gear: proposals asking this can&apos;t be sent
                                </Badge>
                              ) : null}
                            </span>
                          </div>
                        }
                        action={updateRule.bind(null, slug, q.id, r.id)}
                        submitLabel="Save rule"
                        discardMessage="Discard the changes you made to this rule?"
                      >
                        <RuleFields prefix={`rule-${i}`} answerType={q.answer_type} options={options} gear={gear} rule={r} />
                      </InlineEditor>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No rules yet: the answer is shown to you but requires no gear.</p>
            )}
            <section aria-labelledby="add-rule-heading" className="grid gap-3 rounded-lg border border-dashed p-3">
              <h3 id="add-rule-heading" className="text-sm font-semibold">Add a rule</h3>
              <ActionForm action={createRule.bind(null, slug, q.id)} submitLabel="Add rule" resetOnSuccess trackUnsaved>
                <RuleFields prefix="new-rule" answerType={q.answer_type} options={options} gear={gear} />
              </ActionForm>
            </section>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Short text answers can&apos;t trigger rules. You&apos;ll read the answer on the submitted proposal.</p>
        )}
      </section>

      <section aria-labelledby="manage-heading" className="grid gap-3 rounded-xl border p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="manage-heading" className="text-base font-semibold">{q.active ? "Manage question" : "Archived question"}</h2>
          <p className="text-sm text-muted-foreground">Archive instead of deleting: its choices and rules are kept.</p>
        </div>
        <ArchivePanel
          noun="question"
          name={`“${q.prompt}”`}
          archived={!q.active}
          action={setQuestionArchived.bind(null, slug, q.id)}
          effects={[
            "It can't be added to templates or proposal drafts.",
            activeTemplates > 0
              ? `${activeTemplates === 1 ? "1 template still asks it" : `${activeTemplates} templates still ask it`}: proposals that ask it, from those templates or drafts, can't be previewed or sent until you remove it there or restore it.`
              : "No active template asks it.",
            "Its choices and rules are kept. Sent proposals don't change.",
          ]}
        />
      </section>
    </>
  );
}
