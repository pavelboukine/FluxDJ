import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { CheckboxField, PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { ContractDocument } from "@/components/contract/contract-document";
import { requireStaff } from "@/lib/auth/staff";
import { templateSectionsSchema } from "@/lib/contracts/content";
import { sectionsToText } from "@/lib/contracts/template-text";
import { UUID_RE } from "@/lib/forms";
import { openContractTemplateDraft, saveContractTemplateDraft, updateContractTemplateDetails } from "../actions";
import { USAGE_LABELS, type TemplateUsage } from "@/lib/contracts/usage";
import { PublishPanel } from "./publish-panel";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default async function ContractTemplatePage({ params }: PageProps<"/staff/[tenant]/contract-templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: template } = await supabase
    .from("contract_templates")
    .select("id, name, active")
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!template) notFound();
  const [{ data: versions }, { data: placeholders }, { count: contractCount }, { data: statement }] = await Promise.all([
    supabase
      .from("contract_template_versions")
      .select("id, version_number, title, sections, placeholders, draft_version, published_at, content_sha256, usage, client_use_statement, client_use_confirmed_at")
      .eq("template_id", template.id)
      .eq("tenant_id", tenant.id)
      .order("version_number", { ascending: false }),
    supabase.rpc("contract_placeholder_catalog"),
    supabase.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("template_id", template.id),
    supabase.rpc("client_use_statement_current"),
  ]);
  const draft = (versions ?? []).find((v) => !v.published_at);
  const published = (versions ?? []).filter((v) => v.published_at);
  const latestNumber = versions?.[0]?.version_number ?? 0;
  const latestPublished = published[0];

  return (
    <>
      <PageHeader
        title={template.name}
        description={<><Link className="underline" href={`/staff/${slug}/contract-templates`}>Back to contract templates</Link> · {published.length} published version(s){contractCount ? ` · used by ${contractCount} contract(s)` : ""}</>}
        actions={template.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="outline">Archived</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid content-start gap-6">
          {draft ? (
            <DraftVersionProvider version={draft.draft_version}>
              <Card>
                <CardHeader>
                  <CardTitle>Draft version {draft.version_number}</CardTitle>
                  <CardDescription>
                    Saved in place. Contracts can only use published versions. Unknown or malformed placeholders are rejected when you save.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">
                  <ActionForm
                    action={saveContractTemplateDraft.bind(null, slug, template.id, draft.id)}
                    version={draft.draft_version}
                    submitLabel="Save draft"
                    trackUnsaved
                  >
                    <TextField label="Document title" name="title" required maxLength={300} defaultValue={draft.title} />
                    <TextAreaField
                      label="Sections"
                      name="content"
                      rows={22}
                      className="font-mono"
                      defaultValue={sectionsToText(templateSectionsSchema.parse(draft.sections))}
                      hint='Start each section with a line like "## Payment". Text is shown exactly as typed; no formatting is applied.'
                    />
                  </ActionForm>
                  <PublishPanel
                    slug={slug}
                    templateId={template.id}
                    versionId={draft.id}
                    versionNumber={draft.version_number}
                    version={draft.draft_version}
                    isOwner={membership.role === "owner"}
                    statement={statement as { version: string; text: string }}
                  />
                </CardContent>
              </Card>
            </DraftVersionProvider>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Edit this template</CardTitle>
                <CardDescription>
                  Published versions never change. Editing starts draft version {latestNumber + 1}, copied from version {latestNumber}.
                  Publish it as DEMO or for client use.
                </CardDescription>
                {latestPublished?.usage === "legacy" ? (
                  <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                    Version {latestPublished.version_number} was published before agreements could be approved for client use, so contracts
                    can&apos;t be generated from it. Start a new draft version (the text is copied as is), review it and publish it for client
                    use. Then regenerate any contract drafts made from the old version.
                  </p>
                ) : null}
              </CardHeader>
              <CardContent>
                <ActionForm action={openContractTemplateDraft.bind(null, slug, template.id)} submitLabel={`Start draft version ${latestNumber + 1}`} pendingLabel="Opening…" variant="outline" inline>
                  <span />
                </ActionForm>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Published versions</CardTitle>
              <CardDescription>Immutable. Contracts record which version they were generated from.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {published.map((v) => (
                <details key={v.id} className="rounded-xl border p-3" open={v === published[0]}>
                  <summary className="cursor-pointer text-sm font-medium">
                    Version {v.version_number} · published {fmt(v.published_at!)} ·{" "}
                    <Badge variant={v.usage === "client_use" ? "default" : "outline"}>{USAGE_LABELS[v.usage as TemplateUsage]}</Badge>
                  </summary>
                  {v.usage === "client_use" && v.client_use_confirmed_at ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Approved for client use by the owner on {fmt(v.client_use_confirmed_at)}, confirming: &ldquo;{v.client_use_statement}&rdquo;
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs break-all text-muted-foreground">Content SHA-256: {v.content_sha256}</p>
                  <div className="mt-4">
                    <ContractDocument title={v.title} sections={templateSectionsSchema.parse(v.sections)} headingLevel={2} />
                  </div>
                </details>
              ))}
              {published.length === 0 ? <p className="text-sm text-muted-foreground">Nothing published yet.</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Template details</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={updateContractTemplateDetails.bind(null, slug, template.id)} submitLabel="Save details">
                <TextField label="Template name" name="name" required maxLength={200} defaultValue={template.name} />
                <CheckboxField label="Active (offered when generating contracts)" name="active" defaultChecked={template.active} />
              </ActionForm>
            </CardContent>
          </Card>
        </div>

        <Card className="content-start">
          <CardHeader>
            <CardTitle>Placeholders</CardTitle>
            <CardDescription>
              Only these placeholders are allowed. Each one a template uses must have a value when a contract is generated; missing
              information blocks generation and says what to complete. Prices come from the approved selection, never the live catalog.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm">
              {(placeholders ?? []).map((p) => (
                <div key={p.key} className="grid gap-0.5">
                  <dt><code className="rounded bg-muted px-1 py-0.5 text-xs">{`{{${p.key}}}`}</code> <span className="font-medium">{p.label}</span></dt>
                  <dd className="text-muted-foreground">{p.description}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
