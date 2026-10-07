import Link from "next/link";
import { ArrowLeft, ImagePlus } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { createGear } from "../actions";
import { GearFields } from "../gear-fields";

/** Add a gear item. Photos and videos are added on its page once it's saved (uploads belong to a saved item). */
export default async function NewGear({ params }: PageProps<"/staff/[tenant]/gear/new">) {
  const { tenant: slug } = await params;
  const { tenant } = await requireStaff(slug);
  const categories = Object.keys((tenant.tax_categories ?? {}) as Record<string, unknown>);
  return (
    <>
      <PageHeader
        title="Add gear"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/gear`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to gear
          </Link>
        }
      />
      <section aria-label="New gear item" className="grid gap-6 rounded-xl border bg-card p-4 sm:p-5">
        <UnsavedGuard>
          <ActionForm
            action={createGear.bind(null, slug)}
            submitLabel="Save and continue"
            pendingLabel="Saving…"
            trackUnsaved
            secondary={<GuardedCancel cancelHref={`/staff/${slug}/gear`} message="Discard this new gear item?" />}
          >
            <GearFields taxCategories={categories} currency={tenant.currency} slug={slug} isNew />
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold">Photos and videos</legend>
              <p className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                <ImagePlus aria-hidden className="mt-0.5 size-4 shrink-0" />
                Save the item first. Its page opens next, where you can add photos and videos.
              </p>
            </fieldset>
          </ActionForm>
        </UnsavedGuard>
      </section>
    </>
  );
}
