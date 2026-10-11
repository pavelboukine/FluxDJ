import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronDown, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { planSections, type PlanSection } from "@/lib/planning/navigation";
import { itemRoles, plural, templateStructure } from "@/lib/planning/template-structure";

/**
 * Read-only preview of the client planning a new event would get from this
 * template: the same sections (planSections, as on the client's page), in
 * the saved order, with their labels and moments. Nothing here touches an
 * event, a plan, client access or answers: it reads the template only.
 */
export default async function PlanningTemplatePreview({ params }: PageProps<"/staff/[tenant]/planning-templates/[templateId]/preview">) {
  const { tenant: slug, templateId } = await params;
  if (!UUID_RE.test(templateId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const [{ data: t }, { data: library }] = await Promise.all([
    supabase
      .from("planning_templates")
      .select("id, name, archived_at, planning_template_items!planning_template_items_template_fk(id, kind, key, parent_id, label, position)")
      .eq("id", templateId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.rpc("planning_library"),
  ]);
  if (!t) notFound();
  const lib = library ?? [];
  const structure = templateStructure(t.planning_template_items, lib);
  const sections = planSections(structure);
  const roles = itemRoles(structure, lib);
  const general = sections.filter((s) => s.kind === "general");
  const stages = sections.filter((s) => s.kind === "stage");
  const shown = new Set(sections.map((s) => s.key));
  const notShown = [...structure.general, ...structure.stages].filter((i) => !shown.has(i.key));
  const back = `/staff/${slug}/planning-templates/${t.id}`;

  const nav = (
    <div className="grid gap-3 text-sm">
      {general.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="px-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Event details</h3>
          <ul className="grid gap-0.5">
            {general.map((s) => <NavItem key={s.key} section={s} />)}
          </ul>
        </div>
      ) : null}
      {stages.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="px-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Your event, in order</h3>
          <ol className="grid gap-0.5">
            {stages.map((s, i) => <NavItem key={s.key} section={s} number={i + 1} />)}
          </ol>
        </div>
      ) : null}
    </div>
  );

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
      <p role="note" className="flex items-start gap-2 rounded-lg border border-sky-600/40 bg-sky-600/10 p-3 text-sm" data-testid="preview-note">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Preview of the planning sections a client gets when an event is planned with this template, in this order. It&apos;s read-only: no event,
          client or answer is involved, and nothing is saved. The client&apos;s page also shows the event&apos;s date and venue, their progress and any
          proposal answers they already gave.
        </span>
      </p>

      {sections.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Clients would have nothing to fill in yet.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
          <nav aria-label="Planning sections (preview)" className="hidden rounded-2xl border bg-card p-2 shadow-sm lg:sticky lg:top-20 lg:block">
            {nav}
          </nav>
          <details className="group/picker rounded-2xl border bg-card shadow-sm lg:hidden">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <span className="font-semibold">{plural(sections.length, "planning section")}</span>
              <span className="flex items-center gap-1 font-medium">
                All sections
                <ChevronDown aria-hidden className="size-4 transition-transform group-open/picker:rotate-180 motion-reduce:transition-none" />
              </span>
            </summary>
            <nav aria-label="Planning sections (preview)" className="border-t p-2">{nav}</nav>
          </details>

          <ol className="grid gap-3" aria-label="Planning sections, in order" data-testid="preview-sections">
            {sections.map((s) => {
              const stageNumber = s.kind === "stage" ? stages.indexOf(s) + 1 : null;
              return (
                <li key={s.key} id={`preview-${s.key}`} className="grid scroll-mt-20 gap-3 rounded-xl border bg-card p-4" data-testid={`preview-${s.key}`}>
                  <div className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground">{s.kind === "general" ? "Event details" : `Stage ${stageNumber}`}</span>
                    <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{s.label}</h2>
                  </div>
                  {s.kind === "general" ? (
                    <p className="text-sm text-muted-foreground">{lib.find((l) => l.key === s.key)?.description ?? "One form for this section."}</p>
                  ) : (
                    <ul className="grid gap-1.5 text-sm" aria-label={`What the client fills in for ${s.label}`}>
                      {s.stageEditor ? (
                        <li className="rounded-lg border px-3 py-2">
                          <span className="font-medium">{s.detailsLabel ?? `${s.label} details`}</span>
                          <span className="block text-xs text-muted-foreground">Timing and other details for this stage.</span>
                        </li>
                      ) : null}
                      {s.moments.map((m) => (
                        <li key={m.key} className="rounded-lg border px-3 py-2">
                          <span className="font-medium">{m.label}</span>
                        </li>
                      ))}
                      {s.covered.map((c) => (
                        <li key={c.label} className="px-3 text-xs text-muted-foreground">
                          {c.label}: {c.by ? `included in ${c.by}` : "included in another section"}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

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

function NavItem({ section, number }: { section: PlanSection; number?: number }) {
  return (
    <li>
      <a href={`#preview-${section.key}`} className="flex min-h-11 items-center gap-1 rounded-lg px-2.5 py-2 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50">
        {number !== undefined ? <span className="text-muted-foreground">{number}.</span> : null}
        <span className="[overflow-wrap:anywhere]">{section.label}</span>
      </a>
    </li>
  );
}
