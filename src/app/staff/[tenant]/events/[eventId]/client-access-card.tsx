import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { RequestIdField } from "@/components/app/request-id-field";
import type { StaffContext } from "@/lib/auth/staff";
import { invitationOpen, type PlanningAccess } from "@/lib/events/workspace";
import { sendPlanningInvitation } from "./client-access-actions";

/**
 * The latest planning invitation, every invitation id (for the Emails card)
 * and whether a client has active access. `primary` is the current primary
 * contact: an invitation sent to someone else, or to an address they no
 * longer have, is marked stale (it no longer works).
 */
export async function loadPlanningAccess(
  staff: StaffContext,
  eventId: string,
  primary: { id: string; email: string } | null,
): Promise<{ access: PlanningAccess; invitationIds: string[] }> {
  const { supabase, tenant } = staff;
  const [{ data: invitations }, { count }] = await Promise.all([
    supabase
      .from("planning_invitations")
      .select("id, client_id, email, created_at, expires_at, revoked_at, accepted_at")
      .eq("tenant_id", tenant.id)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
    supabase.from("event_access").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("event_id", eventId).is("revoked_at", null),
  ]);
  const latest = invitations?.[0] ?? null;
  return {
    access: {
      invitation: latest
        ? {
            id: latest.id,
            email: latest.email,
            createdAt: latest.created_at,
            expiresAt: latest.expires_at,
            revoked: Boolean(latest.revoked_at),
            accepted: Boolean(latest.accepted_at),
            stale: !primary || primary.id !== latest.client_id || primary.email.toLowerCase() !== latest.email,
          }
        : null,
      clientHasAccess: (count ?? 0) > 0,
    },
    invitationIds: (invitations ?? []).map((i) => i.id),
  };
}

/**
 * Client access for an event booked elsewhere: who can open planning, the
 * latest invitation, and the invite form. Inviting is always a staff action;
 * creating the event or setting up planning sends nothing.
 */
export function ClientAccessCard({
  slug,
  eventId,
  access,
  planningReady,
  primary,
  archived,
  fmt,
}: {
  slug: string;
  eventId: string;
  access: PlanningAccess;
  /** Planning is set up (not Event basics from booking awaiting setup). */
  planningReady: boolean;
  primary: { name: string; email: string; archived: boolean } | null;
  archived: boolean;
  fmt: (iso: string) => string;
}) {
  const i = access.invitation;
  const open = invitationOpen(i, new Date());
  const blocked = archived
    ? "Unarchive the event to invite the client."
    : !planningReady
      ? "Set up planning before inviting the client."
      : !primary || primary.archived
        ? "Add an active primary contact to invite."
        : null;
  return (
    <Card id="client-access" className="scroll-mt-20" data-testid="client-access">
      <CardHeader>
        <CardTitle>Client access</CardTitle>
        <CardDescription>
          The client plans online after confirming their email address. Nothing is sent until you invite them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p data-testid="client-access-state">
          {access.clientHasAccess
            ? "The client has verified access and can open planning (and edit it while client editing is open)."
            : open && i
              ? `Invitation sent ${fmt(i.createdAt)} to ${i.email}. It works until ${fmt(i.expiresAt)}; the client hasn't opened it yet.`
              : i
                ? `The last invitation (sent ${fmt(i.createdAt)} to ${i.email}) ${
                    i.revoked ? "was replaced or cancelled" : i.stale ? "no longer works: the primary contact or their email changed" : "expired"
                  }.`
                : "Not invited yet."}
        </p>
        {blocked ? (
          <p className="text-muted-foreground">
            {blocked}
            {!archived && !planningReady ? (
              <>
                {" "}
                <Link className="font-medium underline" href={`/staff/${slug}/events/${eventId}/planning`}>Set up planning</Link>
              </>
            ) : null}
          </p>
        ) : (
          // Remounted for each new invitation, so the next send gets a new request id.
          <ActionForm
            key={i?.id ?? "none"}
            action={sendPlanningInvitation.bind(null, slug, eventId)}
            submitLabel={i || access.clientHasAccess ? "Send a new invitation" : `Invite ${primary!.name}`}
            pendingLabel="Sending…"
            variant={i || access.clientHasAccess ? "outline" : "default"}
            confirm={open ? "Send a new invitation? The link in the earlier email will stop working." : undefined}
          >
            <RequestIdField />
            <p className="text-muted-foreground">
              Emails {primary!.name} ({primary!.email}) a link to confirm their email and open planning. Review the planning first: they see
              what you set up.
            </p>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}
