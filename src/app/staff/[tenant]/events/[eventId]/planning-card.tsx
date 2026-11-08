import type { ReactNode } from "react";
import { AlertTriangle, ClipboardList } from "lucide-react";
import Link from "@/components/app/pending-link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StaffContext } from "@/lib/auth/staff";
import { editingLine } from "@/lib/events/workspace";
import { formatInstant } from "@/lib/planning/cutoff";
import { planAwaitingSetup, planOpenedToClient, progressSummaryLine, staffPlanningViewSchema } from "@/lib/planning/view";
import { cn } from "@/lib/utils";

/** The event's planning view (read only: rendering never sets up a plan). */
export async function loadPlanning(staff: StaffContext, eventId: string) {
  const { data } = await staff.supabase.rpc("staff_planning_view", { p_event_id: eventId });
  const parsed = staffPlanningViewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Touch-sized on phones, the usual size from sm. */
const action = "h-11 sm:h-9";

/**
 * Where the event's planning stands (progress, client editing and its
 * deadline), with links to planning and the run sheet, then client access
 * (`access`, the invitation workflow) as part of the same section. Staff only.
 */
export function PlanningCard({ slug, eventId, view, archived, external = false, businessTimeZone, access }: {
  slug: string;
  eventId: string;
  view: Awaited<ReturnType<typeof loadPlanning>>;
  archived: boolean;
  /** Booked elsewhere: staff set planning up themselves; nothing is set up by a booking. */
  external?: boolean;
  /** The business's own zone: a deadline in another zone names it. */
  businessTimeZone: string;
  /** Client access to planning (ClientAccess), when the event has any. */
  access?: ReactNode;
}) {
  if (!view && !access) return null;
  const base = `/staff/${slug}/events/${eventId}`;
  const plan = view?.plan ?? null;
  // A set-up plan's view (progress, client editing); null when there's none.
  const planned = view && view.plan !== null ? view : null;
  const awaitingSetup = view ? planAwaitingSetup(view) : false;
  const editing = planned && !awaitingSetup ? planned.editing : null;
  return (
    <Card id="planning" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Planning</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {view ? (
          <>
            <div className="grid gap-1">
              {plan === null ? (
                <p>
                  <span className="font-medium">Not set up yet.</span>{" "}
                  <span className="text-muted-foreground">
                    {external ? "Set it up and choose a template to start planning with the client." : "Booking sets it up automatically; you can also set it up now."}
                  </span>
                </p>
              ) : awaitingSetup ? (
                <p>
                  <span className="font-medium">Not set up: booked with Event basics only.</span>{" "}
                  <span className="text-muted-foreground">Choose a planning template; the client can&apos;t edit planning until you do.</span>
                </p>
              ) : planned ? (
                <>
                  <p className="font-medium" data-testid="planning-progress">{progressSummaryLine(planned.progress)}</p>
                  {planOpenedToClient(planned) ? null : (
                    <p data-testid="planning-card-not-opened">
                      <span className="font-medium">Planning is ready, but your client can&apos;t access it yet.</span>{" "}
                      <span className="text-muted-foreground">Review it, then open it under Client access.</span>
                    </p>
                  )}
                  {editing ? (
                    <p data-testid="planning-card-editing" title={formatInstant(editing.state === "closed" ? (editing.closed_at ?? editing.deadline) : (editing.closes_at ?? editing.deadline), editing.timezone)}>
                      {editingLine(editing, { now: new Date(), businessTimeZone })}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {planned.plan.origin === "template" ? `From the template “${planned.plan.source_template_name}”` : "Sections chosen on this event"} · progress counts available sections only
                  </p>
                </>
              ) : null}
              {editing?.schedule_changed ? (
                <p className="flex gap-1.5 text-amber-800 dark:text-amber-300">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  The deadline no longer matches the event date.
                </p>
              ) : null}
              {plan === null && archived ? <p className="text-muted-foreground">Unarchive the event to set up planning.</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {plan === null && archived ? null : (
                <Link className={cn(buttonVariants({ variant: "outline" }), action)} href={`${base}/planning`}>
                  {plan === null || awaitingSetup ? "Set up planning" : "Open planning"}
                </Link>
              )}
              {plan !== null ? (
                <Link className={cn(buttonVariants({ variant: "outline" }), action)} href={`${base}/run-sheet`}>
                  <ClipboardList aria-hidden /> Open run sheet
                </Link>
              ) : null}
            </div>
          </>
        ) : null}
        {access}
      </CardContent>
    </Card>
  );
}
