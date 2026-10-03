import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { createTemplate } from "./actions";

export default async function Templates({ params }: PageProps<"/staff/[tenant]/templates">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: templates } = await supabase
    .from("proposal_templates")
    .select("id, name, expiry_days, active, proposal_template_packages!proposal_template_packages_template_fk(count)")
    .eq("tenant_id", tenant.id)
    .order("active", { ascending: false })
    .order("name");
  return (
    <>
      <PageHeader title="Proposal templates" description="Reusable starting points: three packages, a recommended one, suggested addons and questions." />
      <ul className="grid gap-2">
        {(templates ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
            <div>
              <Link className="font-medium hover:underline" href={`/staff/${slug}/templates/${t.id}`}>{t.name}</Link>
              <div className="text-xs text-muted-foreground">{t.proposal_template_packages[0]?.count ?? 0} of 3 packages · expires after {t.expiry_days} days</div>
            </div>
            {t.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
          </li>
        ))}
        {templates?.length === 0 ? <li className="text-sm text-muted-foreground">No templates yet.</li> : null}
      </ul>
      <Card>
        <CardHeader><CardTitle>New template</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={createTemplate.bind(null, slug)} submitLabel="Create template">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name" name="name" required maxLength={200} placeholder="Wedding" />
              <TextField label="Proposal expiry (days)" name="expiry_days" type="number" min={1} max={365} defaultValue={14} />
              <TextAreaField className="sm:col-span-2" label="Intro shown to clients" name="intro" rows={3} maxLength={10000} />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
