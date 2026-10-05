import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
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
        <Link className="justify-self-start underline" href={`/staff/${slug}/events/${eventId}/planning`}>
          {view.plan === null ? "Set up planning" : "Open planning"}
        </Link>
      </CardContent>
    </Card>
  );
}
