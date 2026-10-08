import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { createPackage } from "../actions";
import { loadGearChoices } from "../gear-choices";
import { IncludedGearEditor } from "../included-gear-editor";
import { PackageFields } from "../package-fields";

/** Add a package, with its included gear in the same form. */
export default async function NewPackage({ params }: PageProps<"/staff/[tenant]/packages/new">) {
  const { tenant: slug } = await params;
  const staff = await requireStaff(slug);
  const { tenant } = staff;
  const { choices, capped } = await loadGearChoices(staff, []);
  return (
    <>
      <PageHeader
        title="Add package"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/packages`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to packages
          </Link>
        }
      />
      <section aria-label="New package" className="grid gap-6 rounded-xl border bg-card p-4 sm:p-5">
        <UnsavedGuard>
          <ActionForm
            action={createPackage.bind(null, slug)}
            submitLabel="Save package"
            pendingLabel="Saving…"
            trackUnsaved
            secondary={<GuardedCancel cancelHref={`/staff/${slug}/packages`} message="Discard this new package?" />}
          >
            <RequestIdField />
            <PackageFields
              taxCategories={Object.keys((tenant.tax_categories ?? {}) as object)}
              currency={tenant.currency}
              slug={slug}
              isNew
              includedGear={<IncludedGearEditor choices={choices} initial={[]} capped={capped} />}
            />
          </ActionForm>
        </UnsavedGuard>
      </section>
    </>
  );
}
