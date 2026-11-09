import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { ClientPlanningWorkspace } from "@/components/planning/client-planning-workspace";
import { PreviewCanvas, PreviewNote } from "@/components/planning/preview-note";
import { requireStaff } from "@/lib/auth/staff";
import { liveBrand } from "@/lib/branding/logo.server";
import { dateIn } from "@/lib/dates";
import { UUID_RE } from "@/lib/forms";
import { planSections } from "@/lib/planning/navigation";
import { templatePreviewView } from "@/lib/planning/preview";
import { itemRoles, templateStructure } from "@/lib/planning/template-structure";

/**
 * What a client gets from this template: the real client planning workspace (the same component as
 * the client's page), on a clearly labelled sample event with no answers, with the business's own
 * branding. Fields work as for a client, including what appears depending on an answer, but nothing
 * is saved: the editors' saves stay in the browser and progress isn't shown. It reads the template,
 * the business's branding and the planning library only; no event, plan, client or answer is involved.
 */
export default async function PlanningTemplatePreview({ params }: PageProps<"/staff/[tenant]/planning-templates/[templateId]/preview">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const [{ data: t }, { data: library }, { data: business }, brand] = await Promise.all([
    supabase
      .from("planning_templates")
      .select("id, name, archived_at, default_event_type, planning_template_items!planning_template_items_template_fk(id, kind, key, parent_id, label, position, questions)")
      .eq("id", templateId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.rpc("planning_library"),
    supabase.from("tenants").select("dj_name").eq("id", tenant.id).maybeSingle(),
    liveBrand(slug),
  ]);
  if (!t) notFound();
  const lib = library ?? [];
  const structure = templateStructure(t.planning_template_items, lib);
  const shown = new Set(planSections(structure).map((s) => s.key));
  const roles = itemRoles(structure, lib);
  const notShown = [...structure.general, ...structure.stages].filter((i) => !shown.has(i.key));
  const view = templatePreviewView({
    structure,
    brand: { displayName: brand?.displayName ?? tenant.display_name, brandColors: brand?.brandColors ?? {} },
    djName: business?.dj_name ?? null,
    eventType: t.default_event_type,
    timezone: tenant.timezone,
    today: dateIn(tenant.timezone, new Date()),
  });
  const back = `/staff/${slug}/planning-templates/${t.id}`;

  return (
    <>
      <PageHeader
        title={`Preview: ${t.name}`}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={back}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to the template
          </Link>
        }
        actions={t.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
      />
      <PreviewCanvas brandColor={view.brand.brand_colors.primary}>
        <ClientPlanningWorkspace
          view={view}
          logo={brand?.logo ?? null}
          preview={
            <PreviewNote>
              This is what a client sees when an event is planned with this template, on a sample event. Try the fields: nothing you
              enter is saved, and progress isn&apos;t shown.
            </PreviewNote>
          }
        />
      </PreviewCanvas>

      {notShown.length > 0 ? (
        <section aria-labelledby="not-shown-heading" className="grid gap-2 rounded-xl border border-dashed p-4 text-sm" data-testid="preview-not-shown">
          <h2 id="not-shown-heading" className="font-medium">In the template but not shown to clients</h2>
          <ul className="grid gap-1 text-muted-foreground">
            {notShown.map((i) => (
              <li key={i.key}>
                <span className="font-medium text-foreground">{i.label}</span>: {roles.get(i.key)?.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

