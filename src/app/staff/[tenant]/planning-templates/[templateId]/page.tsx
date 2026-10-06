import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { PageHeader, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { StructureEditor, type StructureStage } from "@/components/planning/structure-editor";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { EVENT_TYPES } from "../../events/event-form";
import {
  addTemplateItem,
  duplicatePlanningTemplate,
  setPlanningTemplateArchived,
  templateItemAction,
  updatePlanningTemplate,
} from "../actions";

export default async function PlanningTemplatePage({ params }: PageProps<"/staff/[tenant]/planning-templates/[templateId]">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: t } = await supabase
    .from("planning_templates")
    .select("id, name, description, starter_key, default_event_type, version, archived_at, planning_template_items!planning_template_items_template_fk(id, kind, key, parent_id, label, position)")
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!t) notFound();
  const { data: library } = await supabase.rpc("planning_library");
  const editors = new Map((library ?? []).map((l) => [l.key, l]));
  const items = [...t.planning_template_items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const toItem = (i: (typeof items)[number]) => ({
    id: i.id,
    key: i.key,
    label: i.label,
    disabled: false,
    editor: editors.get(i.key)?.editor ?? null,
    removable: editors.get(i.key)?.removable ?? true,
  });
  const general = items.filter((i) => i.kind === "general").map(toItem);
  const stages: StructureStage[] = items
    .filter((i) => i.kind === "stage")
    .map((s) => ({ ...toItem(s), moments: items.filter((m) => m.parent_id === s.id).map(toItem) }));
  const archived = Boolean(t.archived_at);

  return (
    <DraftVersionProvider version={t.version}>
      <PageHeader
        title={t.name}
        description={<Link className="underline" href={`/staff/${slug}/planning-templates`}>Back to planning templates</Link>}
        actions={archived ? <Badge variant="outline">Archived</Badge> : null}
      />
      {archived ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This template is archived: it can&apos;t be edited or chosen for new events. Events already planned with it keep their own copy.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            The default event type is an explicit choice: an event of that type booked without a chosen template is planned with this
            one. Without a default, booking creates Event basics only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={updatePlanningTemplate.bind(null, slug, t.id)} submitLabel="Save details" version={t.version} trackUnsaved>
            <fieldset disabled={archived} className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name" name="name" required maxLength={120} defaultValue={t.name} />
              <SelectField
                label="Default for event type"
                name="default_event_type"
                defaultValue={t.default_event_type ?? ""}
                options={EVENT_TYPES.map(([value, label]) => ({ value, label }))}
                placeholder="— none —"
              />
              <TextAreaField className="sm:col-span-2" label="Description (optional)" name="description" rows={2} maxLength={1000} defaultValue={t.description ?? ""} />
            </fieldset>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Structure</CardTitle>
          <CardDescription>
            Stages follow the event in order; each holds its moments. Rename labels freely (keys stay the same). Stage details and songs can
            be filled in; names, pronunciation and speeches arrive with the next planning editors. Sections marked &quot;Not available
            yet&quot; have no client inputs today.
            Templates describe structure only, never prices or contracted services.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StructureEditor
            mode="template"
            general={general}
            stages={stages}
            version={t.version}
            itemAction={templateItemAction.bind(null, slug, t.id)}
            addAction={addTemplateItem.bind(null, slug, t.id)}
            library={library ?? []}
            readOnly={archived}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Duplicate or archive</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <ActionForm action={duplicatePlanningTemplate.bind(null, slug, t.id)} submitLabel="Duplicate" pendingLabel="Duplicating…">
            <TextField label="Name of the copy" name="name" id="copy_name" required maxLength={120} defaultValue={`${t.name} (copy)`} className="max-w-sm" />
          </ActionForm>
          <ActionForm
            action={setPlanningTemplateArchived.bind(null, slug, t.id, !archived)}
            submitLabel={archived ? "Unarchive template" : "Archive template"}
            variant="outline"
          >
            <p className="text-sm text-muted-foreground">
              {archived
                ? "Unarchiving makes it available for new events again."
                : "Archiving hides it from template choices and clears its event-type default. Nothing is deleted, and events already planned with it are unaffected."}
            </p>
          </ActionForm>
        </CardContent>
      </Card>
    </DraftVersionProvider>
  );
}
