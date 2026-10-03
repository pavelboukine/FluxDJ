import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { DEMO_TEMPLATE_NAME, DEMO_TEMPLATE_TEXT, DEMO_TEMPLATE_TITLE } from "@/lib/contracts/demo-template";
import { createContractTemplate } from "./actions";

export default async function ContractTemplates({ params }: PageProps<"/staff/[tenant]/contract-templates">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: templates } = await supabase
    .from("contract_templates")
    .select("id, name, active, contract_template_versions!contract_template_versions_template_fk(version_number, published_at)")
    .eq("tenant_id", tenant.id)
    .order("active", { ascending: false })
    .order("name");

  return (
    <>
      <PageHeader
        title="Contract templates"
        description="Versioned agreement text with placeholders. Published versions never change; contracts are generated from them."
      />
      <ul className="grid gap-2">
        {(templates ?? []).map((t) => {
          const versions = t.contract_template_versions;
          const published = versions.filter((v) => v.published_at).map((v) => v.version_number);
          const draft = versions.find((v) => !v.published_at);
          return (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
              <div>
                <Link className="font-medium hover:underline" href={`/staff/${slug}/contract-templates/${t.id}`}>{t.name}</Link>
                <div className="text-xs text-muted-foreground">
                  {published.length ? `Published: version ${Math.max(...published)}` : "Not published yet"}
                  {draft ? ` · draft version ${draft.version_number}` : ""}
                </div>
              </div>
              {t.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
            </li>
          );
        })}
        {templates?.length === 0 ? <li className="text-sm text-muted-foreground">No contract templates yet.</li> : null}
      </ul>
      <Card>
        <CardHeader>
          <CardTitle>New contract template</CardTitle>
          <CardDescription>
            The text below is DEMO wording for testing placeholders and pricing only. It is not a reviewed agreement. Replace it with
            wording your lawyer has reviewed before using it with clients.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createContractTemplate.bind(null, slug)} submitLabel="Create template draft">
            <TextField label="Template name" name="name" required maxLength={200} defaultValue={DEMO_TEMPLATE_NAME} />
            <TextField label="Document title" name="title" required maxLength={300} defaultValue={DEMO_TEMPLATE_TITLE} />
            <TextAreaField
              label="Sections"
              name="content"
              rows={18}
              className="font-mono"
              defaultValue={DEMO_TEMPLATE_TEXT}
              hint='Start each section with a line like "## Parties". Placeholders such as {{client.name}} are listed on the template page.'
            />
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
