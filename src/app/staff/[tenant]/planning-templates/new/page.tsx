import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { GuardedCancel, UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { plural, structureCounts } from "@/lib/planning/template-structure";
import { createPlanningTemplate } from "../actions";
import { StartingPointFields, type StartingPoint } from "./starting-point";

const OUTLINES: StartingPoint[] = [
  {
    value: "wedding",
    label: "Wedding outline",
    detail: "Ceremony to closing in the order of the day, with contacts, DJ preferences and the moments of each stage.",
    suggestedName: "Wedding",
  },
  {
    value: "simple_party",
    label: "Simple Party outline",
    detail: "Event basics and a party stage with Must play and Do not play. For birthdays and other simple parties.",
    suggestedName: "Party",
  },
  { value: "basics", label: "Event basics only", detail: "Start small and add sections, stages and moments one by one.", suggestedName: "" },
];

/** Create a planning template from an outline or a copy of one of the business's templates (?from=<id> preselects a copy). */
export default async function NewPlanningTemplate({ params, searchParams }: PageProps<"/staff/[tenant]/planning-templates/new">) {
  const { tenant: slug } = await params;
  const from = (await searchParams).from;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: templates, error } = await supabase
    .from("planning_templates")
    .select("id, name, planning_template_items!planning_template_items_template_fk(kind)")
    .eq("tenant_id", tenant.id)
    .is("archived_at", null)
    .order("name");
  if (error) throw new Error("The planning templates couldn't be loaded.");
  const copies: StartingPoint[] = (templates ?? []).map((t) => {
    const c = structureCounts(t.planning_template_items);
    return {
      value: `copy:${t.id}`,
      label: t.name,
      detail: `${plural(c.general, "general section")} · ${plural(c.stages, "stage")} · ${plural(c.moments, "moment")}`,
      suggestedName: `${t.name} (copy)`,
    };
  });
  const initial = typeof from === "string" && UUID_RE.test(from) && copies.some((c) => c.value === `copy:${from}`) ? `copy:${from}` : "wedding";
  const base = `/staff/${slug}/planning-templates`;

  return (
    <>
      <PageHeader
        title="Create planning template"
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={base}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to planning templates
          </Link>
        }
      />
      <section aria-label="New planning template" className="grid gap-6 rounded-xl border bg-card p-4 sm:p-5">
        <UnsavedGuard>
          <ActionForm
            action={createPlanningTemplate.bind(null, slug)}
            submitLabel="Create template"
            pendingLabel="Creating…"
            trackUnsaved
            secondary={<GuardedCancel cancelHref={base} message="Discard this new template?" />}
          >
            <RequestIdField />
            <StartingPointFields outlines={OUTLINES} copies={copies} initial={initial} />
            <p className="text-sm text-muted-foreground">
              Next you&apos;ll see the template&apos;s structure and can rename, reorder and trim it. Nothing reaches clients until an event is planned with it.
            </p>
          </ActionForm>
        </UnsavedGuard>
      </section>
    </>
  );
}
