import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { loadGearChoices } from "@/lib/catalog/gear-choices.server";
import { createTemplate } from "../actions";
import { loadTemplateChoices } from "../choices.server";
import { TemplateContentsEditor } from "../template-contents-editor";
import { TemplateDetailsFields, TemplateSettingsFields } from "../template-fields";

/** Add a proposal template, with its packages, questions and extras in the same form. */
export default async function NewTemplate({ params }: PageProps<"/staff/[tenant]/templates/new">) {
  const { tenant: slug } = await params;
  const staff = await requireStaff(slug);
  const [{ packages, questions }, { choices: gear }] = await Promise.all([loadTemplateChoices(staff, { packageIds: [], questionIds: [] }), loadGearChoices(staff, [])]);
  return (
    <>
      <PageHeader
        title="Add proposal template"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/templates`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to proposal templates
          </Link>
        }
      />
      <section aria-label="New proposal template" className="grid gap-6 rounded-xl border bg-card p-4 sm:p-5">
        <UnsavedGuard>
          <ActionForm
            action={createTemplate.bind(null, slug)}
            submitLabel="Save template"
            pendingLabel="Saving…"
            trackUnsaved
            secondary={<GuardedCancel cancelHref={`/staff/${slug}/templates`} message="Discard this new template?" />}
          >
            <RequestIdField />
            <TemplateDetailsFields withSettings={false} />
            <TemplateContentsEditor
              packages={packages}
              questions={questions}
              gear={gear}
              currency={staff.tenant.currency}
              initial={{ packageIds: ["", "", ""], recommended: "", questionIds: [], addons: [] }}
            />
            <TemplateSettingsFields />
          </ActionForm>
        </UnsavedGuard>
      </section>
    </>
  );
}
