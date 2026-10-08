import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { createQuestion } from "../actions";
import { QuestionFields } from "../question-fields";

/** Add a question. Its rules are added on its page once it's saved (a rule belongs to a saved question). */
export default async function NewQuestion({ params }: PageProps<"/staff/[tenant]/questions/new">) {
  const { tenant: slug } = await params;
  await requireStaff(slug);
  return (
    <>
      <PageHeader
        title="Add question"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/questions`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to questions &amp; rules
          </Link>
        }
      />
      <section aria-label="New question" className="grid gap-6 rounded-xl border bg-card p-4 sm:p-5">
        <UnsavedGuard>
          <ActionForm
            action={createQuestion.bind(null, slug)}
            submitLabel="Save question"
            pendingLabel="Saving…"
            trackUnsaved
            secondary={<GuardedCancel cancelHref={`/staff/${slug}/questions`} message="Discard this new question?" />}
          >
            <QuestionFields />
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              Rules come next: once the question is saved, its page lets you say which answers require which gear.
            </p>
          </ActionForm>
        </UnsavedGuard>
      </section>
    </>
  );
}
