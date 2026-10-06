import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
import { formatInstant } from "@/lib/planning/cutoff";
import { progressHeadline, staffPlanningViewSchema } from "@/lib/planning/view";

/** Where the event's planning stands, with a link to it. Staff only. */
export async function PlanningCard({ staff, slug, eventId }: { staff: StaffContext; slug: string; eventId: string }) {
  const { data } = await staff.supabase.rpc("staff_planning_view", { p_event_id: eventId });
  const parsed = staffPlanningViewSchema.safeParse(data);
  if (!parsed.success) return null;
  const view = parsed.data;
  return (
    <Card>
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
      <CardContent className="grid gap-2 text-sm">
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
                : "Client planning is read-only (deadline passed). Staff can still edit."}
            {view.editing.schedule_changed ? <span className="text-amber-700 dark:text-amber-400"> The deadline no longer matches the event date.</span> : null}
          </p>
        ) : null}
        <Link className="justify-self-start underline" href={`/staff/${slug}/events/${eventId}/planning`}>
          {view.plan === null ? "Set up planning" : "Open planning"}
        </Link>
      </CardContent>
    </Card>
  );
}
