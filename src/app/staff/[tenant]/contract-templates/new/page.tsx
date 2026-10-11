import Link from "next/link";
import { ArrowLeft, Copy, FileUp, PenLine } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, SelectField, TextField } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { DEMO_TEMPLATE_NAME, DEMO_TEMPLATE_SECTIONS, DEMO_TEMPLATE_TITLE } from "@/lib/contracts/demo-template";
import { EXAMPLE_VALUES } from "@/lib/contracts/fields";
import { createContractTemplate } from "../actions";
import { SectionEditor } from "../section-editor";
import { ImportFlow } from "./import-flow";

const STARTS = ["import", "copy", "write", "demo"] as const;
type Start = (typeof STARTS)[number];

/**
 * Create a contract template: import a Word document (converted and reviewed
 * before anything is saved), copy one of the business's templates, or write
 * one (blank, or the DEMO sample text for testing). Every route creates the
 * template with draft version 1 in one retry-safe request.
 */
export default async function NewContractTemplate({ params, searchParams }: PageProps<"/staff/[tenant]/contract-templates/new">) {
  const { tenant: slug } = await params;
  const raw = (await searchParams).start;
  const start = (STARTS as readonly string[]).includes(String(raw)) ? (raw as Start) : null;
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/contract-templates`;
  const [{ data: templates }, { data: catalog }] = await Promise.all([
    supabase.from("contract_templates").select("id, name, active").eq("tenant_id", tenant.id).order("active", { ascending: false }).order("name"),
    supabase.rpc("contract_placeholder_catalog"),
  ]);
  const choices = [
    { start: "import", icon: FileUp, title: "Import a Word document", detail: "Upload the .docx you already use. You review the converted text before anything is saved." },
    { start: "copy", icon: Copy, title: "Copy a template", detail: (templates ?? []).length ? "Start from one of your templates, for example for another language or event type." : "You have no templates to copy yet." },
    { start: "write", icon: PenLine, title: "Write it here", detail: "Start with an empty section and add yours." },
  ] as const;

  return (
    <>
      <PageHeader
        title="Create contract template"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={start ? `${base}/new` : base}>
            <ArrowLeft aria-hidden className="size-3.5" />
            {start ? "Choose another way to start" : "Back to contract templates"}
          </Link>
        }
      />

      {start === null ? (
        <nav aria-label="How to start" className="grid gap-3 md:grid-cols-3">
          {choices.map((c) => {
            const disabled = c.start === "copy" && !(templates ?? []).length;
            const inner = (
              <>
                <c.icon aria-hidden className="size-5 text-muted-foreground" />
                <span className="font-medium">{c.title}</span>
                <span className="text-sm text-muted-foreground">{c.detail}</span>
              </>
            );
            return disabled ? (
              <div key={c.start} className="grid content-start gap-2 rounded-xl border border-dashed p-4 opacity-70">{inner}</div>
            ) : (
              <Link key={c.start} href={`${base}/new?start=${c.start}`} className="grid content-start gap-2 rounded-xl border bg-card p-4 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
                {inner}
              </Link>
            );
          })}
          <p className="text-sm text-muted-foreground md:col-span-3">
            Just testing? <Link className="underline" href={`${base}/new?start=demo`}>Start from the DEMO sample text</Link>: placeholder wording to try
            fields, pricing and signing. It isn&apos;t an agreement.
          </p>
        </nav>
      ) : start === "import" ? (
        <ImportFlow slug={slug} listHref={base} />
      ) : start === "copy" ? (
        <section aria-label="Copy a template" className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
          <ActionForm action={createContractTemplate.bind(null, slug)} submitLabel="Create draft" pendingLabel="Creating…" secondary={<Link className="text-sm underline" href={base}>Cancel</Link>}>
            <RequestIdField />
            <input type="hidden" name="start" value="copy" />
            <SelectField
              label="Template to copy"
              name="source_id"
              required
              defaultValue=""
              placeholder="Choose…"
              options={(templates ?? []).map((t) => ({ value: t.id, label: t.active ? t.name : `${t.name} (archived)` }))}
              hint="Its newest version is copied, draft or published. The original doesn't change."
              className="max-w-md"
            />
            <TextField label="Name of the new template" name="name" required maxLength={200} className="max-w-md" />
          </ActionForm>
        </section>
      ) : (
        <section aria-label="New contract template" className="grid gap-4">
          {start === "demo" ? (
            <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              DEMO sample text: placeholder wording for testing fields, pricing and signing. It isn&apos;t an agreement and must be replaced with your
              own wording before client use. You are responsible for your agreement; Flux DJ does not review it.
            </p>
          ) : null}
          <UnsavedGuard>
            <ActionForm
              action={createContractTemplate.bind(null, slug)}
              submitLabel="Create draft"
              pendingLabel="Creating…"
              trackUnsaved
              secondary={<GuardedCancel cancelHref={base} message="Discard this new template?" />}
              className="[&>div:last-child]:sticky [&>div:last-child]:bottom-0 [&>div:last-child]:z-10 [&>div:last-child]:-mx-1 [&>div:last-child]:border-t [&>div:last-child]:bg-background/95 [&>div:last-child]:px-1 [&>div:last-child]:py-3"
            >
              <RequestIdField />
              <input type="hidden" name="start" value="write" />
              <TextField label="Template name" name="name" required maxLength={200} defaultValue={start === "demo" ? DEMO_TEMPLATE_NAME : ""} hint="Staff see this name. Clients see the document title." className="max-w-md" />
              <SectionEditor
                initialTitle={start === "demo" ? DEMO_TEMPLATE_TITLE : ""}
                initialSections={start === "demo" ? DEMO_TEMPLATE_SECTIONS : []}
                fields={catalog ?? []}
                exampleValues={EXAMPLE_VALUES}
              />
            </ActionForm>
          </UnsavedGuard>
        </section>
      )}
    </>
  );
}
