import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Copy, Eye, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { ArchivePanel } from "@/components/app/archive-panel";
import { PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { UnsavedGuard } from "@/components/app/unsaved-guard";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { addableItems, itemRoles, plural, templateStructure } from "@/lib/planning/template-structure";
import { EVENT_TYPES } from "../../events/event-form";
import { addTemplateItem, setPlanningTemplateArchived, templateItemAction, updatePlanningTemplate } from "../actions";
import { TemplateStructureEditor, type EditorItem, type EditorStage } from "./structure-editor";

/**
 * One planning template: what clients will be asked (its structure, each
 * item's role in client planning), its details and event-type default, a
 * preview, copying it as a starting point, and archiving. Edits apply to
 * future plans only: a plan is a copy made when an event's planning starts.
 */
export default async function PlanningTemplatePage({ params, searchParams }: PageProps<"/staff/[tenant]/planning-templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  const created = (await searchParams).created;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const [{ data: t }, { data: library }, { count: plansCopied }] = await Promise.all([
    supabase
      .from("planning_templates")
      .select("id, name, description, starter_key, default_event_type, version, archived_at, planning_template_items!planning_template_items_template_fk(id, kind, key, parent_id, label, position)")
      .eq("id", templateId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.rpc("planning_library"),
    supabase.from("event_plans").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("source_template_id", templateId),
  ]);
  if (!t) notFound();
  const lib = library ?? [];
  const structure = templateStructure(t.planning_template_items, lib);
  const roles = itemRoles(structure, lib);
  const addable = addableItems(structure, lib);
  const toItem = (i: { id: string; key: string; label: string }, removable = true): EditorItem => ({
    id: i.id,
    key: i.key,
    label: i.label,
    removable,
    role: roles.get(i.key) ?? { kind: "not_shown", text: "" },
  });
  const general = structure.general.map((g) => toItem(g, g.removable));
  const stages: EditorStage[] = structure.stages.map((s) => ({ ...toItem(s), moments: s.moments.map((m) => toItem(m)), addable: addable.momentsFor(s.key) }));
  const archived = Boolean(t.archived_at);
  const base = `/staff/${slug}/planning-templates`;
  const copied = plansCopied ?? 0;
  const typeLabel = new Map<string, string>(EVENT_TYPES);

  return (
    <UnsavedGuard>
      <PageHeader
        title={t.name}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={base}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to planning templates
          </Link>
        }
        actions={
          <>
            {archived ? <Badge variant="secondary">Archived</Badge> : <Badge variant="outline">Active</Badge>}
            <Link className={buttonVariants({ variant: "outline" })} href={`${base}/${t.id}/preview`}>
              <Eye aria-hidden />
              Preview
            </Link>
          </>
        }
      />
      {created === "replayed" ? (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
          This template was already created: an earlier attempt went through, but its reply didn&apos;t arrive. Check its structure below.
        </p>
      ) : null}
      {archived ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This template is archived: it can&apos;t be edited or chosen for new events. Events already planned with it keep their own copy.
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="future-events-note">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Changes to this template apply to events whose planning starts later. Existing event plans won&apos;t change
          {copied > 0 ? ` (${plural(copied, "event")} already ${copied === 1 ? "has its" : "have their"} own copy)` : ""}: their sections, order and answers stay as they are.
          To change one event, use its Planning page.
        </span>
      </p>

      <TemplateStructureEditor
        general={general}
        stages={stages}
        addableGeneral={addable.general}
        addableStages={addable.stages}
        version={t.version}
        itemAction={templateItemAction.bind(null, slug, t.id)}
        addAction={addTemplateItem.bind(null, slug, t.id)}
        readOnly={archived}
      />

      <section aria-labelledby="details-heading" className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="details-heading" className="text-base font-semibold">Name and default</h2>
          <p className="text-sm text-muted-foreground">
            {t.default_event_type
              ? `New ${typeLabel.get(t.default_event_type) ?? t.default_event_type} events start planning with this template unless staff choose another when setting planning up.`
              : "Not a default. Staff can still choose it when they set up an event's planning; booked events without a chosen template use their type's default, or Event basics only."}
          </p>
        </div>
        <ActionForm action={updatePlanningTemplate.bind(null, slug, t.id)} submitLabel="Save details" version={t.version} trackUnsaved>
          <fieldset disabled={archived} className="grid gap-4 sm:grid-cols-2">
            <TextField label="Name" name="name" required maxLength={120} defaultValue={t.name} />
            <SelectField
              label="Default for event type"
              name="default_event_type"
              defaultValue={t.default_event_type ?? ""}
              options={EVENT_TYPES.map(([value, label]) => ({ value, label }))}
              placeholder="— none —"
              hint="One template per event type. Used when an event of that type is booked without a chosen template."
            />
            <TextAreaField className="sm:col-span-2" label="Description (optional)" name="description" rows={2} maxLength={1000} defaultValue={t.description ?? ""} hint="For your team; clients don't see it." />
          </fieldset>
        </ActionForm>
      </section>

      <section aria-labelledby="more-heading" className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="more-heading" className="text-base font-semibold">Copy or archive</h2>
        {archived ? null : (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">Start a new template from this one, for example a second language or a smaller version.</p>
            <div>
              <Link className={buttonVariants({ variant: "outline" })} href={`${base}/new?from=${t.id}`}>
                <Copy aria-hidden />
                Use as a starting point
              </Link>
            </div>
          </div>
        )}
        <ArchivePanel
          noun="template"
          name={t.name}
          archived={archived}
          action={setPlanningTemplateArchived.bind(null, slug, t.id)}
          effects={[
            "It's no longer offered when setting up an event's planning.",
            t.default_event_type
              ? `It stops being the default for ${typeLabel.get(t.default_event_type) ?? t.default_event_type} events (booked events of that type start with Event basics only until another template is the default).`
              : "It isn't a default for any event type, so booking is unaffected.",
            "Events already planned with it keep their own copy.",
          ]}
        />
      </section>
    </UnsavedGuard>
  );
}
