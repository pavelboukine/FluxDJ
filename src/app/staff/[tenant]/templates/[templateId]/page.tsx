import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Info, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ArchivePanel } from "@/components/app/archive-panel";
import { PageHeader } from "@/components/app/fields";
import { GearThumb } from "@/components/app/gear-thumb";
import { InlineEditor } from "@/components/app/inline-editor";
import { requireStaff } from "@/lib/auth/staff";
import { loadGearChoices } from "@/lib/catalog/gear-choices.server";
import { answerTypeLabel, ruleStatement, type QuestionOption } from "@/lib/catalog/rules";
import { templateProblems } from "@/lib/catalog/template-problems";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { saveTemplateComposition, setTemplateArchived, updateTemplate } from "../actions";
import { loadTemplateChoices } from "../choices.server";
import { TemplateContentsEditor } from "../template-contents-editor";
import { TemplateDetailsFields } from "../template-fields";

/**
 * One proposal template: what clients will be offered (three packages in
 * order, the recommended one, the questions and their rules, the extras),
 * what would stop a proposal from being sent, Edit details and Edit
 * contents, and archiving.
 */
export default async function TemplatePage({ params, searchParams }: PageProps<"/staff/[tenant]/templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const created = (await searchParams).created;
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const { data: t } = await supabase
    .from("proposal_templates")
    .select(
      "id, name, intro, expiry_days, active, default_package_id, proposal_template_packages!proposal_template_packages_template_fk(package_id, sort_order), proposal_template_addons(gear_item_id, recommended_quantity, max_quantity, sort_order), proposal_template_questions(question_id, sort_order)",
    )
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!t) notFound();

  const slots = [1, 2, 3].map((n) => t.proposal_template_packages.find((p) => p.sort_order === n)?.package_id ?? "") as [string, string, string];
  const packageIds = slots.filter(Boolean);
  const questionIds = [...t.proposal_template_questions].sort((a, b) => a.sort_order - b.sort_order).map((q) => q.question_id);
  const addons = [...t.proposal_template_addons].sort((a, b) => a.sort_order - b.sort_order);

  const [{ packages, questions }, { choices: gear }, { data: asked }] = await Promise.all([
    loadTemplateChoices(staff, { packageIds, questionIds }),
    loadGearChoices(staff, addons.map((a) => a.gear_item_id)),
    questionIds.length
      ? supabase
          .from("logistics_questions")
          .select("id, prompt, options, logistics_rules(id, condition, required_quantity, active, gear_items(id, name, active, tax_category))")
          .eq("tenant_id", tenant.id)
          .in("id", questionIds)
      : Promise.resolve({ data: [] as never[], error: null }),
  ]);
  const pkgById = new Map(packages.map((p) => [p.id, p]));
  const qById = new Map(questions.map((q) => [q.id, q]));
  const askedById = new Map((asked ?? []).map((q) => [q.id, q]));
  const gearById = new Map(gear.map((g) => [g.id, g]));
  const chosenPackages = packageIds.map((id) => pkgById.get(id)).filter((p) => p !== undefined);
  const ruleGear = (asked ?? []).flatMap((q) =>
    q.logistics_rules.filter((r) => r.active && r.gear_items).map((r) => ({ id: r.gear_items!.id, name: r.gear_items!.name, active: r.gear_items!.active, questionId: q.id, taxCategory: r.gear_items!.tax_category })),
  );
  const extras = addons.flatMap((a) => (gearById.get(a.gear_item_id) ? [gearById.get(a.gear_item_id)!] : []));
  const problems = templateProblems(
    {
      packages: chosenPackages,
      recommendedId: t.default_package_id,
      questions: questionIds.flatMap((id) => (qById.get(id) ? [{ id, prompt: qById.get(id)!.prompt, active: qById.get(id)!.active }] : [])),
      extras,
      ruleGear,
      configuredTaxCategories: Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>),
      gearTaxCategories: [...extras.map((g) => g.taxCategory), ...ruleGear.map((g) => g.taxCategory)],
    },
    {
      edit: "#contents",
      package: (id) => `/staff/${slug}/packages/${id}`,
      question: (id) => `/staff/${slug}/questions/${id}`,
      gear: (id) => `/staff/${slug}/gear/${id}`,
      taxes: `/staff/${slug}/settings#taxes`,
    },
  );

  return (
    <>
      <PageHeader
        title={t.name}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/templates`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to proposal templates
          </Link>
        }
        actions={t.active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Archived</Badge>}
      />
      {created === "1" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">Template created.</p>
      ) : created === "replayed" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          This template was already saved: an earlier attempt went through, but its reply didn&apos;t arrive. Check its contents below.
        </p>
      ) : null}
      {!t.active ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This template is archived. It isn&apos;t offered under “Start from template”; proposals already made from it are unchanged.
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        A proposal copies this template when it&apos;s started or the template is applied to it. Later changes here don&apos;t reach existing drafts, and sent
        proposals never change.
      </p>

      {problems.length > 0 ? (
        <section aria-labelledby="problems-heading" className="grid gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4" data-testid="template-problems">
          <h2 id="problems-heading" className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle aria-hidden className="size-4" />
            Proposals from this template can&apos;t be sent yet
          </h2>
          <ul className="grid gap-1 text-sm">
            {problems.map((p, i) => (
              <li key={i}>
                {p.text}{" "}
                <Link className="font-medium underline" href={p.href}>{p.linkLabel}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InlineEditor
        id="details"
        title="Details"
        editLabel="Edit details"
        view={
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="grid gap-0.5 sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">Intro shown to clients</dt>
              <dd className="whitespace-pre-line">{t.intro ?? <span className="text-muted-foreground italic">No intro</span>}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Proposal expiry</dt>
              <dd>{t.expiry_days} day{t.expiry_days === 1 ? "" : "s"} after sending</dd>
            </div>
          </dl>
        }
        action={updateTemplate.bind(null, slug, t.id)}
        submitLabel="Save details"
        discardMessage="Discard the changes you made to this template's details?"
      >
        <TemplateDetailsFields template={t} />
      </InlineEditor>

      <InlineEditor
        id="contents"
        title="What clients are offered"
        editLabel="Edit packages, questions and extras"
        view={
          <div className="grid gap-6">
            <section aria-label="Packages" className="grid gap-2">
              <h3 className="text-sm font-semibold">Packages, in the order clients see them</h3>
              <ol className="grid gap-3 lg:grid-cols-3" data-testid="template-packages">
                {slots.map((id, i) => {
                  const p = id ? pkgById.get(id) : undefined;
                  const recommended = Boolean(id) && id === t.default_package_id;
                  return (
                    <li key={i} className="grid content-start gap-1 rounded-lg border p-3 text-sm" data-testid="template-package">
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        Package {i + 1}
                        {recommended ? (
                          <Badge className="gap-1">
                            <Star aria-hidden className="size-3" />
                            Recommended
                          </Badge>
                        ) : null}
                        {p && !p.active ? <Badge variant="secondary">Archived</Badge> : null}
                      </span>
                      {p ? (
                        <>
                          <Link className="font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/packages/${p.id}`}>{p.name}</Link>
                          <span>
                            <span className="font-semibold">{formatCents(p.basePriceCents, tenant.currency)}</span> <span className="text-xs text-muted-foreground">base price, before tax</span>
                          </span>
                          <span className="text-xs text-muted-foreground">{p.gearSummary}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground italic">No package chosen</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>

            <section aria-label="Questions" className="grid gap-2">
              <h3 className="text-sm font-semibold">Questions, in the order clients see them</h3>
              {questionIds.length > 0 ? (
                <ol className="grid gap-2" data-testid="template-questions">
                  {questionIds.map((id, i) => {
                    const q = qById.get(id);
                    const a = askedById.get(id);
                    const rules = (a?.logistics_rules ?? []).filter((r) => r.active);
                    return (
                      <li key={id} className="grid gap-1 rounded-lg border p-3 text-sm" data-testid="template-question">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium [overflow-wrap:anywhere]">
                            {i + 1}.{" "}
                            <Link className="underline-offset-4 hover:underline" href={`/staff/${slug}/questions/${id}`}>{q?.prompt ?? "Unavailable question"}</Link>
                          </span>
                          {q && !q.active ? <Badge variant="secondary">Archived</Badge> : null}
                        </span>
                        {q ? <span className="text-xs text-muted-foreground">{answerTypeLabel(q.answerType)} · {q.required ? "Required" : "Optional"}</span> : null}
                        {rules.length > 0 ? (
                          <ul className="grid gap-0.5 text-xs">
                            {rules.map((r) => (
                              <li key={r.id} className="[overflow-wrap:anywhere]">
                                {ruleStatement(a!.prompt, r.condition, (a!.options ?? []) as QuestionOption[], r.required_quantity, r.gear_items?.name ?? "unavailable gear")}
                                {r.gear_items && !r.gear_items.active ? <span className="text-amber-800 dark:text-amber-300"> (archived gear)</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-xs text-muted-foreground">No rules: the answer is shown to you but requires no gear.</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No questions. Proposals from this template won&apos;t ask any, so no rules apply.</p>
              )}
              {questionIds.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Required gear: when several rules match, their quantities add up for each item. Units the chosen package includes count toward that total; only
                  the remainder is added to the proposal, at the gear&apos;s unit price.
                </p>
              ) : null}
            </section>

            <section aria-label="Optional extras" className="grid gap-2">
              <h3 className="text-sm font-semibold">Optional extras</h3>
              {addons.length > 0 ? (
                <ul className="divide-y rounded-lg border" data-testid="template-extras">
                  {addons.map((a) => {
                    const g = gearById.get(a.gear_item_id);
                    return (
                      <li key={a.gear_item_id} className="flex items-center gap-3 p-3 text-sm">
                        <GearThumb url={g?.thumbUrl ?? null} />
                        <span className="grid min-w-0 flex-1">
                          {g ? (
                            <Link className="truncate font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/gear/${g.id}`}>{g.name}</Link>
                          ) : (
                            <span className="text-muted-foreground">Unavailable gear item</span>
                          )}
                          {g && !g.active ? <span className="text-xs text-amber-800 dark:text-amber-300">Archived gear</span> : null}
                        </span>
                        <span className="shrink-0 text-right text-xs text-muted-foreground">
                          {a.recommended_quantity > 0 ? `${a.recommended_quantity} preselected` : "Not preselected"}
                          <br />
                          up to {a.max_quantity}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No optional extras.</p>
              )}
            </section>
          </div>
        }
        action={saveTemplateComposition.bind(null, slug, t.id)}
        submitLabel="Save contents"
        discardMessage="Discard the changes you made to this template's packages, questions and extras?"
      >
        <TemplateContentsEditor
          packages={packages}
          questions={questions}
          gear={gear}
          currency={tenant.currency}
          initial={{
            packageIds: slots,
            recommended: t.default_package_id ?? "",
            questionIds,
            addons: addons.map((a) => ({ id: a.gear_item_id, rec: a.recommended_quantity, max: a.max_quantity })),
          }}
        />
      </InlineEditor>

      <section aria-labelledby="manage-heading" className="grid gap-3 rounded-xl border p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="manage-heading" className="text-base font-semibold">{t.active ? "Manage template" : "Archived template"}</h2>
          <p className="text-sm text-muted-foreground">Archive instead of deleting: its contents are kept.</p>
        </div>
        <ArchivePanel
          noun="template"
          name={t.name}
          archived={!t.active}
          action={setTemplateArchived.bind(null, slug, t.id)}
          effects={[
            "It's no longer offered under “Start from template” on events and proposal drafts.",
            "Drafts already started from it keep their packages, questions and extras.",
            "Sent proposals don't change.",
          ]}
        />
      </section>
    </>
  );
}
