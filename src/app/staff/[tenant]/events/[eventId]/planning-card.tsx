import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
import { formatInstant } from "@/lib/planning/cutoff";
import { progressHeadline, staffPlanningViewSchema } from "@/lib/planning/view";

/** The event's planning view (read only: rendering never sets up a plan). */
export async function loadPlanning(staff: StaffContext, eventId: string) {
  const { data } = await staff.supabase.rpc("staff_planning_view", { p_event_id: eventId });
  const parsed = staffPlanningViewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Where the event's planning stands, with links to it and the run sheet. Staff only. */
export function PlanningCard({ slug, eventId, view, archived }: { slug: string; eventId: string; view: Awaited<ReturnType<typeof loadPlanning>>; archived: boolean }) {
  if (!view) return null;
  const base = `/staff/${slug}/events/${eventId}`;
  return (
    <Card id="planning" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Planning</CardTitle>
        <CardDescription>
          {view.plan === null
            ? "Not set up yet. Booking sets it up automatically; you can also set it up now and choose a template."
            : view.plan.origin === "template"
              ? `From the template "${view.plan.source_template_name}".`
              : "Event basics only: choose a template to add the event's stages."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {view.plan !== null ? (
          <p>
            {progressHeadline(view.progress)} <span className="text-muted-foreground">(available sections only)</span>
          </p>
        ) : null}
        {view.plan !== null && view.editing ? (
          <p data-testid="planning-card-editing">
            {view.editing.state === "open"
              ? `Client editing open until ${formatInstant(view.editing.deadline, view.editing.timezone)}.`
              : view.editing.state === "reopened"
                ? `Client editing reopened until ${formatInstant(view.editing.closes_at ?? view.editing.deadline, view.editing.timezone)}.`
                : `Client planning is read-only (deadline passed ${formatInstant(view.editing.deadline, view.editing.timezone)}). Staff can still edit.`}
            {view.editing.schedule_changed ? <span className="text-amber-700 dark:text-amber-400"> The deadline no longer matches the event date.</span> : null}
          </p>
        ) : null}
        {view.plan === null && archived ? <p className="text-muted-foreground">Unarchive the event to set up planning.</p> : null}
        <div className="flex flex-wrap gap-2">
          {view.plan === null && archived ? null : (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${base}/planning`}>
              {view.plan === null ? "Set up planning" : "Edit planning"}
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
