import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/app/fields";
import { ClientPlanningWorkspace } from "@/components/planning/client-planning-workspace";
import { PreviewCanvas, PreviewNote } from "@/components/planning/preview-note";
import { requireStaff } from "@/lib/auth/staff";
import { liveBrand } from "@/lib/branding/logo.server";
import { UUID_RE } from "@/lib/forms";
import { eventPreviewView } from "@/lib/planning/preview";
import { planAwaitingSetup, planOpenedToClient, staffPlanningViewSchema } from "@/lib/planning/view";

/**
 * "Preview as client": this event's plan in the real client planning workspace, as its client would
 * get it (hidden sections left out, the answers saved so far, the client's deadline and read-only
 * state), whether or not planning is open to them yet. Staff can try the fields, but nothing is saved:
 * the editors' saves stay in the browser and progress isn't shown. It reads only what the staff
 * planning page reads (staff_planning_view); it never opens planning or changes answers.
 */
export default async function EventPlanningPreview({ params }: PageProps<"/staff/[tenant]/events/[eventId]/planning/preview">) {
  const { tenant: slug, eventId } = await params;
  if (!UUID_RE.test(eventId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: event } = await supabase
    .from("events")
    .select("id, title, event_type, event_date, timezone, venue_name, venue_address, dj_name, archived_at")
    .eq("id", eventId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!event) notFound();
  const [{ data: viewData }, { data: business }, brand] = await Promise.all([
    supabase.rpc("staff_planning_view", { p_event_id: event.id }),
    supabase.from("tenants").select("dj_name").eq("id", tenant.id).maybeSingle(),
    liveBrand(slug),
  ]);
  const staffView = staffPlanningViewSchema.parse(viewData);
  const planningHref = `/staff/${slug}/events/${event.id}/planning`;
  const header = (
    <PageHeader
      title={`Preview as client: ${event.title}`}
      description={
        <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={planningHref}>
          <ArrowLeft aria-hidden className="size-3.5" />
          Back to planning
        </Link>
      }
      actions={event.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
    />
  );
  // Nothing a client could be shown yet: say so, and where to set it up.
  if (staffView.plan === null || planAwaitingSetup(staffView)) {
    return (
      <>
        {header}
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="preview-not-set-up">
          Planning isn&apos;t set up for this event yet, so there&apos;s nothing to preview. <Link className="font-medium text-foreground underline" href={planningHref}>Set up planning</Link>.
        </p>
      </>
    );
  }
  const view = eventPreviewView({
    view: staffView,
    event: {
      id: event.id,
      title: event.title,
      event_type: event.event_type,
      event_date: event.event_date,
      timezone: event.timezone,
      venue_name: event.venue_name,
      venue_address: event.venue_address,
    },
    brand: { displayName: brand?.displayName ?? tenant.display_name, brandColors: brand?.brandColors ?? {} },
    djName: event.dj_name ?? business?.dj_name ?? null,
  });
  const opened = planOpenedToClient(staffView);

  return (
    <>
      {header}
      <PreviewCanvas brandColor={view.brand.brand_colors.primary} readOnly={view.editing?.state === "closed"}>
        <ClientPlanningWorkspace
          view={view}
          logo={brand?.logo ?? null}
          preview={
            <PreviewNote>
              {event.archived_at
                ? "The event is archived, so the client can't open planning. This is what it would look like."
                : opened
                  ? "This is what your client sees, with the answers saved so far."
                  : "Your client can't see this yet: planning isn't open to them. This is what they'll see once you open it."}{" "}
              Try the fields: nothing you enter here is saved, and progress isn&apos;t shown.
            </PreviewNote>
          }
        />
      </PreviewCanvas>
    </>
  );
}
