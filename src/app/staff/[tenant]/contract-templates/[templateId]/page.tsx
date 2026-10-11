import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "@/components/app/action-form";
import { ArchivePanel } from "@/components/app/archive-panel";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { PageHeader, TextField } from "@/components/app/fields";
import { ContractDocument } from "@/components/contract/contract-document";
import { requireStaff } from "@/lib/auth/staff";
import { templateSectionsSchema } from "@/lib/contracts/content";
import { EXAMPLE_VALUES } from "@/lib/contracts/fields";
import { UUID_RE } from "@/lib/forms";
import { openContractTemplateDraft, renameContractTemplate, saveContractTemplateDraft, setContractTemplateArchived } from "../actions";
import { SectionEditor } from "../section-editor";
import { UsageBadge } from "../usage-badge";
import { PublishPanel } from "./publish-panel";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/**
 * One contract template: its draft (edited section by section, previewed with
 * example values, then published as DEMO or, by the owner, for client use),
 * its published versions (read-only, newest first), its name and archiving.
 * Published versions never change; editing one starts a new draft version.
 */
export default async function ContractTemplatePage({ params, searchParams }: PageProps<"/staff/[tenant]/contract-templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const created = (await searchParams).created;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: template } = await supabase.from("contract_templates").select("id, name, active").eq("id", templateId).eq("tenant_id", tenant.id).maybeSingle();
  if (!template) notFound();
  const [{ data: versions }, { data: catalog }, { count: contractCount }, { data: statement }, { data: business }] = await Promise.all([
    supabase
      .from("contract_template_versions")
      .select("id, version_number, title, sections, draft_version, published_at, content_sha256, usage, client_use_statement, client_use_confirmed_at")
      .eq("template_id", template.id)
      .eq("tenant_id", tenant.id)
      .order("version_number", { ascending: false }),
    supabase.rpc("contract_placeholder_catalog"),
    supabase.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("template_id", template.id),
    supabase.rpc("client_use_statement_current"),
    supabase.from("tenants").select("business_name, display_name, contact_email, business_address").eq("id", tenant.id).single(),
  ]);
  const draft = (versions ?? []).find((v) => !v.published_at);
  const published = (versions ?? []).filter((v) => v.published_at);
  const latestNumber = versions?.[0]?.version_number ?? 0;
  const current = published[0];
  const base = `/staff/${slug}/contract-templates`;
  // The preview shows the business's own details where they're set; everything else is an example.
  const examples = {
    ...EXAMPLE_VALUES,
    ...Object.fromEntries(
      [
        ["business.name", business?.business_name],
        ["business.legal_name", business?.business_name],
        ["business.display_name", business?.display_name],
        ["business.email", business?.contact_email],
        ["business.address", business?.business_address],
      ].filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""),
    ),
  };

  return (
    <>
      <PageHeader
        title={template.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={base}>
              <ArrowLeft aria-hidden className="size-3.5" />
              Back to contract templates
            </Link>
            <span>
              {current ? `Version ${current.version_number} is the current published version` : "Not published yet"}
              {contractCount ? ` · used by ${contractCount} contract${contractCount === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        }
        actions={template.active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Archived</Badge>}
      />
      {created === "1" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">Template created as draft version 1. Edit it below, then publish it.</p>
      ) : created === "replayed" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          This template was already created: an earlier attempt went through, but its reply didn&apos;t arrive. Check its text below.
        </p>
      ) : null}
      {!template.active ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This template is archived: it isn&apos;t offered when generating contracts. Contracts already generated from it are unchanged.
        </p>
      ) : null}

      {draft ? (
        <DraftVersionProvider version={draft.draft_version}>
          <section aria-labelledby="draft-heading" className="grid gap-4">
            <div className="grid gap-1">
              <h2 id="draft-heading" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                Draft version {draft.version_number} <Badge variant="secondary">Draft</Badge>
              </h2>
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                Only you and your staff see drafts. Contracts can only be generated from a published version
                {current ? ` (now version ${current.version_number})` : ""}; publishing this draft makes it the current one.
              </p>
            </div>
            <ActionForm
              action={saveContractTemplateDraft.bind(null, slug, template.id, draft.id)}
              version={draft.draft_version}
              submitLabel="Save draft"
              trackUnsaved
              className="[&>div:last-child]:sticky [&>div:last-child]:bottom-0 [&>div:last-child]:z-10 [&>div:last-child]:-mx-1 [&>div:last-child]:border-t [&>div:last-child]:bg-background/95 [&>div:last-child]:px-1 [&>div:last-child]:py-3"
            >
              <SectionEditor initialTitle={draft.title} initialSections={templateSectionsSchema.parse(draft.sections)} fields={catalog ?? []} exampleValues={examples} />
            </ActionForm>
            <section aria-labelledby="publish-heading" className="grid gap-2 rounded-xl border bg-card p-4 sm:p-5">
              <h2 id="publish-heading" className="text-base font-semibold">Publish</h2>
              <p className="text-sm text-muted-foreground">
                Publishing freezes the saved draft as version {draft.version_number}. Publish as DEMO to test generating and signing; the owner
                publishes your own agreement for client use. Contracts already generated keep the version they were made from.
              </p>
              <PublishPanel
                slug={slug}
                templateId={template.id}
                versionId={draft.id}
                versionNumber={draft.version_number}
                version={draft.draft_version}
                isOwner={membership.role === "owner"}
                statement={statement as { version: string; text: string }}
              />
            </section>
          </section>
        </DraftVersionProvider>
      ) : (
        <section aria-labelledby="edit-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
          <h2 id="edit-heading" className="text-base font-semibold">Edit this template</h2>
          <p className="text-sm text-muted-foreground">
            Published versions never change. Editing starts draft version {latestNumber + 1}, a copy of version {latestNumber}; nothing changes for
            clients until you publish it.
          </p>
          {current?.usage === "legacy" ? (
            <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              Version {current.version_number} was published before agreements could be approved for client use, so contracts can&apos;t be generated
              from it. Start a new draft version (the text is copied as is), review it and publish it for client use. Then regenerate any contract
              drafts made from the old version.
            </p>
          ) : null}
          <ActionForm action={openContractTemplateDraft.bind(null, slug, template.id)} submitLabel={`Start draft version ${latestNumber + 1}`} pendingLabel="Opening…" variant="outline" inline>
            <span />
          </ActionForm>
        </section>
      )}

      <section aria-labelledby="history-heading" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="history-heading" className="text-lg font-semibold">Published versions</h2>
          <p className="text-sm text-muted-foreground">Read-only. Each contract records the version it was generated from.</p>
        </div>
        {published.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Nothing published yet.</p>
        ) : (
          <ul className="grid divide-y rounded-xl border bg-card" aria-label="Published versions">
            {published.map((v) => (
              <li key={v.id}>
                <details className="group" open={v === current}>
                  <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                    <span className="font-medium">Version {v.version_number} · published {fmt(v.published_at!)}</span>
                    <UsageBadge usage={v.usage} />
                    {v === current ? <Badge variant="secondary">Current</Badge> : null}
                    <span className="ml-auto text-xs text-muted-foreground group-open:hidden">Show</span>
                    <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">Hide</span>
                  </summary>
                  <div className="grid gap-3 border-t px-4 py-4">
                    {v.usage === "client_use" && v.client_use_confirmed_at ? (
                      <p className="text-xs text-muted-foreground">
                        Approved for client use by the owner on {fmt(v.client_use_confirmed_at)}, confirming: &ldquo;{v.client_use_statement}&rdquo;
                      </p>
                    ) : null}
                    <p className="text-xs break-all text-muted-foreground">Content SHA-256: {v.content_sha256}</p>
                    <ContractDocument title={v.title} sections={templateSectionsSchema.parse(v.sections)} headingLevel={2} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="settings-heading" className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="settings-heading" className="text-base font-semibold">Name and archiving</h2>
        <ActionForm action={renameContractTemplate.bind(null, slug, template.id)} submitLabel="Save name">
          <TextField label="Template name" name="name" required maxLength={200} defaultValue={template.name} hint="Staff see this name when generating a contract. Clients see the document title." className="max-w-md" />
        </ActionForm>
        <ArchivePanel
          noun="template"
          name={template.name}
          archived={!template.active}
          action={setContractTemplateArchived.bind(null, slug, template.id)}
          effects={["It's no longer offered when generating contracts.", "Contracts already generated from it, sent or signed, don't change.", "Its versions stay as they are."]}
        />
      </section>
    </>
  );
}
