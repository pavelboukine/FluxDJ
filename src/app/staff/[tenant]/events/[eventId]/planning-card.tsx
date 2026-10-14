import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
import { formatInstant } from "@/lib/planning/cutoff";
import { planAwaitingSetup, progressSummaryLine, staffPlanningViewSchema } from "@/lib/planning/view";

/** The event's planning view (read only: rendering never sets up a plan). */
export async function loadPlanning(staff: StaffContext, eventId: string) {
  const { data } = await staff.supabase.rpc("staff_planning_view", { p_event_id: eventId });
  const parsed = staffPlanningViewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Where the event's planning stands, with links to it and the run sheet. Staff only. */
export function PlanningCard({ slug, eventId, view, archived, external = false }: {
  slug: string;
  eventId: string;
  view: Awaited<ReturnType<typeof loadPlanning>>;
  archived: boolean;
  /** Booked elsewhere: staff set planning up themselves; nothing is set up by a booking. */
  external?: boolean;
}) {
  if (!view) return null;
  const base = `/staff/${slug}/events/${eventId}`;
  const awaitingSetup = planAwaitingSetup(view);
  return (
    <Card id="planning" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Planning</CardTitle>
        <CardDescription>
          {view.plan === null
            ? external
              ? "Not set up yet. Set it up and choose a template to start planning with the client."
              : "Not set up yet. Booking sets it up automatically; you can also set it up now and choose a template."
            : awaitingSetup
              ? "Not set up: booked with Event basics only. Choose a planning template; the client can't edit planning until you do."
              : view.plan.origin === "template"
                ? `From the template "${view.plan.source_template_name}".`
                : "No template: this event's sections were chosen on the event."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {view.plan !== null ? (
          <p>
            {progressSummaryLine(view.progress)} <span className="text-muted-foreground">(available sections only)</span>
          </p>
        ) : null}
        {view.plan !== null && view.editing && !awaitingSetup ? (
          <p data-testid="planning-card-editing">
            {view.editing.state === "open"
              ? `Client editing open until ${formatInstant(view.editing.deadline, view.editing.timezone)}.`
              : view.editing.state === "reopened"
                ? `Client editing reopened until ${formatInstant(view.editing.closes_at ?? view.editing.deadline, view.editing.timezone)}.`
                : view.editing.closed_at
                  ? `Client editing closed by staff (${formatInstant(view.editing.closed_at, view.editing.timezone)}). Staff can still edit.`
                  : `Client planning is read-only (deadline passed ${formatInstant(view.editing.deadline, view.editing.timezone)}). Staff can still edit.`}
            {view.editing.schedule_changed ? <span className="text-amber-700 dark:text-amber-400"> The deadline no longer matches the event date.</span> : null}
          </p>
        ) : null}
        {view.plan === null && archived ? <p className="text-muted-foreground">Unarchive the event to set up planning.</p> : null}
        <div className="flex flex-wrap gap-2">
          {view.plan === null && archived ? null : (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${base}/planning`}>
              {view.plan === null || awaitingSetup ? "Set up planning" : "Edit planning"}
            </Link>
          )}
          {view.plan !== null ? (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${base}/run-sheet`}>Open run sheet</Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
