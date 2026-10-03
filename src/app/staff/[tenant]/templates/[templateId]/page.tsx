import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { saveTemplateComposition, updateTemplate } from "../actions";

export default async function TemplatePage({ params }: PageProps<"/staff/[tenant]/templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: t } = await supabase
    .from("proposal_templates")
    .select(
      "id, name, intro, expiry_days, active, default_package_id, proposal_template_packages!proposal_template_packages_template_fk(package_id, sort_order), proposal_template_addons(gear_item_id, recommended_quantity, max_quantity), proposal_template_questions(question_id)",
    )
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!t) notFound();
  const [{ data: packages }, { data: gear }, { data: questions }] = await Promise.all([
    supabase.from("packages").select("id, name, base_price_cents").eq("tenant_id", tenant.id).eq("active", true).order("sort_order"),
    supabase.from("gear_items").select("id, name, default_price_cents").eq("tenant_id", tenant.id).eq("active", true).order("name"),
    supabase.from("logistics_questions").select("id, prompt, required").eq("tenant_id", tenant.id).eq("active", true).order("sort_order"),
  ]);
  const byPosition = new Map(t.proposal_template_packages.map((p) => [p.sort_order, p.package_id]));
  const addons = new Map(t.proposal_template_addons.map((a) => [a.gear_item_id, a]));
  const asked = new Set(t.proposal_template_questions.map((q) => q.question_id));
  const packageOptions = (packages ?? []).map((p) => ({ value: p.id, label: `${p.name} (${formatCents(p.base_price_cents, tenant.currency)})` }));

  return (
    <>
      <PageHeader title={t.name} description={<Link className="underline" href={`/staff/${slug}/templates`}>Back to templates</Link>} />
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updateTemplate.bind(null, slug, t.id)} submitLabel="Save details">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name" name="name" required maxLength={200} defaultValue={t.name} />
              <TextField label="Proposal expiry (days)" name="expiry_days" type="number" min={1} max={365} defaultValue={t.expiry_days} />
              <TextAreaField className="sm:col-span-2" label="Intro shown to clients" name="intro" rows={3} defaultValue={t.intro ?? ""} />
              <CheckboxField label="Active" name="active" defaultChecked={t.active} />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What this template offers</CardTitle>
          <CardDescription>Only active catalog records are listed. Proposals copy this and can be adjusted per event.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveTemplateComposition.bind(null, slug, t.id)} submitLabel="Save template contents">
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-medium">Packages, in display order</legend>
              {[1, 2, 3].map((n) => (
                <SelectField key={n} label={`Package ${n}`} name={`package_${n}`} id={`package_${n}`} defaultValue={byPosition.get(n) ?? ""} options={packageOptions} placeholder="— none —" />
              ))}
              <SelectField className="sm:col-span-3" label="Recommended (most popular) package" name="default_package_id" defaultValue={t.default_package_id ?? ""} options={packageOptions} placeholder="— choose —" hint="Usually the middle package. Must be one of the three." />
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Optional addons</legend>
              {(gear ?? []).map((g) => {
                const a = addons.get(g.id);
                return (
                  <div key={g.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b pb-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="addon" value={g.id} defaultChecked={Boolean(a)} className="size-4 accent-primary" />
                      {g.name} <span className="text-xs text-muted-foreground">{formatCents(g.default_price_cents, tenant.currency)}</span>
                    </label>
                    <label className="flex items-center gap-1 text-xs">
                      Preselect <Input name={`rec:${g.id}`} type="number" min={0} max={100} defaultValue={a?.recommended_quantity ?? 0} className="w-16" />
                    </label>
                    <label className="flex items-center gap-1 text-xs">
                      Max <Input name={`max:${g.id}`} type="number" min={1} max={100} defaultValue={a?.max_quantity ?? 1} className="w-16" />
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Logistics questions</legend>
              {(questions ?? []).map((q) => (
                <label key={q.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="question" value={q.id} defaultChecked={asked.has(q.id)} className="size-4 accent-primary" />
                  {q.prompt} {q.required ? null : <span className="text-xs text-muted-foreground">(optional)</span>}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
