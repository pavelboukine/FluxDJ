import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { createRule, setRuleActive, updateQuestion } from "../actions";
import { RuleToggle } from "./rule-toggle";

type Option = { value: string; label: string };

function describeCondition(condition: unknown, options: Option[]): string {
  const c = condition as { op: string; value?: unknown; values?: string[] };
  const label = (v: unknown) => options.find((o) => o.value === v)?.label ?? String(v);
  if (c.op === "equals") return typeof c.value === "boolean" ? `answer is ${c.value ? "yes" : "no"}` : `answer is "${label(c.value)}"`;
  if (c.op === "in") return `answer is one of ${(c.values ?? []).map((v) => `"${label(v)}"`).join(", ")}`;
  return `answer includes "${label(c.value)}"`;
}

export default async function QuestionPage({ params }: PageProps<"/staff/[tenant]/questions/[questionId]">) {
  const { tenant: slug, questionId } = await params;
  if (!UUID_RE.test(questionId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: q } = await supabase
    .from("logistics_questions")
    .select("id, key, prompt, answer_type, options, required, active, sort_order, logistics_rules(id, condition, required_quantity, reason, active, gear_items(name))")
    .eq("id", questionId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!q) notFound();
  const { data: gear } = await supabase.from("gear_items").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name");
  const options = (q.options ?? []) as Option[];
  const choice = q.answer_type === "single_choice" || q.answer_type === "multi_choice";

  return (
    <>
      <PageHeader title={q.prompt} description={<><Link className="underline" href={`/staff/${slug}/questions`}>Back to questions</Link> · {q.key}</>} />
      <Card>
        <CardHeader><CardTitle>Question</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updateQuestion.bind(null, slug, q.id, choice)} submitLabel="Save question">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField className="sm:col-span-2" label="Question" name="prompt" required maxLength={500} defaultValue={q.prompt} />
              {choice ? (
                <TextAreaField className="sm:col-span-2" label="Options" name="options" rows={4} defaultValue={options.map((o) => `${o.value} | ${o.label}`).join("\n")} hint="Values used by rules cannot be removed while the rule is active." />
              ) : null}
              <TextField label="Order" name="sort_order" type="number" min={0} max={10000} defaultValue={q.sort_order} />
              <div className="grid gap-2">
                <CheckboxField label="Required" name="required" defaultChecked={q.required} hint="Missing required answers block submission." />
                <CheckboxField label="Active" name="active" defaultChecked={q.active} />
              </div>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>When the answer matches, the client must take at least this much gear. Package inclusions count toward it.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <ul className="grid gap-2">
            {q.logistics_rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <div>
                  If {describeCondition(r.condition, options)} → require {r.required_quantity} × {r.gear_items?.name}
                  <div className="text-xs text-muted-foreground">Client sees: “{r.reason}”</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
                  <RuleToggle action={setRuleActive.bind(null, slug, q.id, r.id, !r.active)} active={r.active} />
                </div>
              </li>
            ))}
            {q.logistics_rules.length === 0 ? <li className="text-sm text-muted-foreground">No rules.</li> : null}
          </ul>
          {q.answer_type === "short_text" ? (
            <p className="text-sm text-muted-foreground">Free-text answers cannot drive rules.</p>
          ) : (
            <ActionForm action={createRule.bind(null, slug, q.id)} submitLabel="Add rule" resetOnSuccess>
              <div className="grid gap-4 sm:grid-cols-2">
                {q.answer_type === "boolean" ? (
                  <SelectField label="When the answer is" name="bool_value" options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                ) : q.answer_type === "single_choice" ? (
                  <fieldset className="grid gap-1 text-sm">
                    <legend className="mb-1 font-medium">When the answer is any of</legend>
                    {options.map((o) => (
                      <label key={o.value} className="flex items-center gap-2">
                        <input type="checkbox" name="values" value={o.value} className="size-4 accent-primary" /> {o.label}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <SelectField label="When the answer includes" name="contains_value" options={options.map((o) => ({ value: o.value, label: o.label }))} />
                )}
                <SelectField label="Require gear" name="gear_item_id" options={(gear ?? []).map((g) => ({ value: g.id, label: g.name }))} placeholder="Choose gear" />
                <TextField label="Quantity" name="required_quantity" type="number" min={1} max={100} defaultValue={1} />
                <TextAreaField className="sm:col-span-2" label="Reason shown to the client" name="reason" rows={2} maxLength={500} placeholder="Your ceremony is in a separate space, so it needs its own speaker." />
              </div>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
