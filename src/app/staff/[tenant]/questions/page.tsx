import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { createQuestion } from "./actions";

const TYPE_LABEL: Record<string, string> = {
  boolean: "Yes / no",
  single_choice: "One choice",
  multi_choice: "Several choices",
  short_text: "Short text",
};

export default async function Questions({ params }: PageProps<"/staff/[tenant]/questions">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: questions } = await supabase
    .from("logistics_questions")
    .select("id, key, prompt, answer_type, required, active, logistics_rules(count)")
    .eq("tenant_id", tenant.id)
    .order("active", { ascending: false })
    .order("sort_order");

  return (
    <>
      <PageHeader title="Logistics questions" description="Asked on proposals. Rules turn answers into required gear (for example, a separate ceremony space needs a speaker)." />
      <ul className="grid gap-2">
        {(questions ?? []).map((q) => (
          <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
            <div>
              <Link className="font-medium hover:underline" href={`/staff/${slug}/questions/${q.id}`}>{q.prompt}</Link>
              <div className="text-xs text-muted-foreground">
                {q.key} · {TYPE_LABEL[q.answer_type]} · {q.required ? "required" : "optional"} · {q.logistics_rules[0]?.count ?? 0} rule(s)
              </div>
            </div>
            {q.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
          </li>
        ))}
        {questions?.length === 0 ? <li className="text-sm text-muted-foreground">No questions yet.</li> : null}
      </ul>
      <Card>
        <CardHeader><CardTitle>New question</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={createQuestion.bind(null, slug)} submitLabel="Create question">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField className="sm:col-span-2" label="Question" name="prompt" required maxLength={500} placeholder="Where will the ceremony take place?" />
              <SelectField label="Answer type" name="answer_type" options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
              <TextField label="Key (optional)" name="key" maxLength={64} pattern="[a-z][a-z0-9_]*" placeholder="ceremony_location" hint="Cannot change later." />
              <TextAreaField className="sm:col-span-2" label="Options (choice questions only)" name="options" rows={3} placeholder={"same_room | Same room as the reception\nseparate_space | A separate space"} hint='One per line: "value | Label", or just a label.' />
              <TextField label="Order" name="sort_order" type="number" min={0} max={10000} defaultValue={0} />
              <CheckboxField label="Required" name="required" defaultChecked />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
