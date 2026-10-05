import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { EVENT_TYPES } from "../events/event-form";
import { createPlanningTemplate, installStarterTemplates } from "./actions";

export default async function PlanningTemplates({ params }: PageProps<"/staff/[tenant]/planning-templates">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: templates } = await supabase
    .from("planning_templates")
    .select("id, name, description, starter_key, default_event_type, archived_at, planning_template_items!planning_template_items_template_fk(kind)")
    .eq("tenant_id", tenant.id)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("name");
  const typeLabel = new Map<string, string>(EVENT_TYPES);
  const hasStarters = new Set((templates ?? []).map((t) => t.starter_key).filter(Boolean));

  return (
    <>
      <PageHeader
        title="Planning templates"
        description="Reusable event structures: general sections plus stages and moments in event order. Each event gets its own copy, so editing a template never changes an event already being planned."
      />
      <ul className="grid gap-2">
        {(templates ?? []).map((t) => {
          const stages = t.planning_template_items.filter((i) => i.kind === "stage").length;
          const moments = t.planning_template_items.filter((i) => i.kind === "moment").length;
          return (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
              <div className="grid gap-0.5">
                <Link className="font-medium hover:underline" href={`/staff/${slug}/planning-templates/${t.id}`}>{t.name}</Link>
                <div className="text-xs text-muted-foreground">
                  {stages} stages · {moments} moments
                  {t.default_event_type ? ` · default for ${typeLabel.get(t.default_event_type) ?? t.default_event_type} events` : ""}
                </div>
              </div>
              {t.archived_at ? <Badge variant="outline">Archived</Badge> : <Badge variant="secondary">Active</Badge>}
            </li>
          );
        })}
        {templates?.length === 0 ? <li className="text-sm text-muted-foreground">No planning templates yet.</li> : null}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle>Starter templates</CardTitle>
          <CardDescription>
            Wedding (ceremony to closing) and Simple Party (event basics, must play and do not play). They are outlines you can rename,
            reorder and trim. Adding them twice does nothing{hasStarters.size === 2 ? "; both are already here" : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={installStarterTemplates.bind(null, slug)} submitLabel="Add starter templates" pendingLabel="Adding…">
            <span className="sr-only">Adds the Wedding and Simple Party starters if they are missing.</span>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New template</CardTitle>
          <CardDescription>Starts with Event basics only. Templates describe structure, not prices or contracted services.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createPlanningTemplate.bind(null, slug)} submitLabel="Create template">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name" name="name" required maxLength={120} placeholder="Corporate evening" />
              <TextAreaField className="sm:col-span-2" label="Description (optional)" name="description" rows={2} maxLength={1000} />
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
