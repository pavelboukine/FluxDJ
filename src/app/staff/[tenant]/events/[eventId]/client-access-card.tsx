import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { RequestIdField } from "@/components/app/request-id-field";
import type { StaffContext } from "@/lib/auth/staff";
import { deliveryState, type OutboxRow } from "@/lib/email/history";
import { invitationOpen, invitationStatus, type InvitationStatus, type PlanningAccess } from "@/lib/events/workspace";
import { cn } from "@/lib/utils";
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
            acceptedAt: latest.accepted_at,
            stale: !primary || primary.id !== latest.client_id || primary.email.toLowerCase() !== latest.email,
          }
        : null,
      clientHasAccess: (count ?? 0) > 0,
    },
    invitationIds: (invitations ?? []).map((i) => i.id),
  };
}

const TONE: Record<InvitationStatus["tone"], string> = {
  normal: "border-border text-foreground",
  pending: "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200",
  good: "border-emerald-600/40 bg-emerald-600/10 text-emerald-900 dark:text-emerald-200",
  attention: "border-amber-600/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

type Blocker = { text: string; link?: { label: string; href: string } };

/**
 * Client access to planning, for a Flux booking and an event booked
 * elsewhere alike: who can open planning, the latest invitation and its
 * delivery, what's missing before inviting, and the Send planning invitation
 * form. Inviting is always a deliberate staff action: creating the event,
 * booking it, setting up planning or opening client editing sends nothing.
 * The database checks every prerequisite again when sending.
 */
export function ClientAccessCard({
  slug,
  eventId,
  access,
  email,
  booked,
  planningReady,
  editingOpen,
  primary,
  archived,
  external,
  fmt,
}: {
  slug: string;
  eventId: string;
  access: PlanningAccess;
  /** The latest invitation's email (outbox row), if loaded. */
  email: OutboxRow | null;
  /** Booked for planning: by Flux (confirmed booking) or affirmed as booked elsewhere. */
  booked: boolean;
  /** Planning is set up (not Event basics from booking awaiting setup). */
  planningReady: boolean;
  /** Client editing is open or reopened (not closed by staff or the deadline). */
  editingOpen: boolean;
  primary: { id: string; name: string; email: string; archived: boolean } | null;
  archived: boolean;
  external: boolean;
  fmt: (iso: string) => string;
}) {
  const now = new Date();
  const i = access.invitation;
  const open = invitationOpen(i, now);
  const status = invitationStatus(i, email, now);
  const planningHref = `/staff/${slug}/events/${eventId}/planning`;
  const blocker: Blocker | null = archived
    ? { text: "Unarchive the event to invite the client." }
    : !booked
      ? { text: "The event isn't booked yet. You can send a planning invitation once the booking is confirmed." }
      : !planningReady
        ? { text: "Set up planning before inviting your client.", link: { label: "Set up planning", href: planningHref } }
        : !editingOpen
          ? { text: "Client editing is closed. Open client editing before inviting your client, so they can fill planning in.", link: { label: "Open the planning page", href: planningHref } }
          : !primary || primary.archived
            ? { text: "Add an active primary contact to invite.", link: { label: "Contacts", href: "#contacts" } }
            : null;
  const delivery = email ? deliveryState(email, now) : null;
  // Contract access alone (a Flux booking) isn't an invitation: the first one is still "Send planning invitation".
  const again = Boolean(i);

  return (
    <Card id="client-access" className="scroll-mt-20" data-testid="client-access">
      <CardHeader>
        <CardTitle>Client access</CardTitle>
        <CardDescription>
          Send a planning invitation when planning is ready for your client. Nothing is sent automatically: not when the event is created
          {external ? "" : " or booked"}, when planning is set up or when client editing opens.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p data-testid="client-access-state">
          {access.clientHasAccess
            ? `The client has verified access and can open planning (and edit it while client editing is open)${external ? "" : ". A planning invitation emails them a link to it"}.`
            : i
              ? open
                ? `Planning invitation for ${i.email}, created ${fmt(i.createdAt)}. It works until ${fmt(i.expiresAt)}; the client hasn't accepted it yet.`
                : `The last planning invitation (${fmt(i.createdAt)}, to ${i.email}) ${
                    i.revoked ? "was replaced or cancelled" : i.stale ? "no longer works: the primary contact or their email changed" : "expired"
                  }.`
              : "Not invited to planning yet."}
        </p>
        {i ? (
          <dl className="grid gap-1.5 rounded-lg border p-3" data-testid="planning-invitation">
            <Row label="Status">
              <span data-testid="planning-invitation-status" className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", TONE[status.tone])}>
                {status.label}
              </span>
            </Row>
            <Row label="Recipient"><span className="[overflow-wrap:anywhere]" data-testid="planning-invitation-recipient">{i.email}</span></Row>
            <Row label="Created">{fmt(i.createdAt)}</Row>
            {email?.sent_at ? <Row label="Sent">{fmt(email.sent_at)}</Row> : null}
            {i.acceptedAt ? <Row label="Accepted">{fmt(i.acceptedAt)}</Row> : null}
            {delivery && !i.accepted && !i.revoked ? (
              <p className={cn("text-xs", delivery.attention ? "flex gap-1.5 text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>
                {delivery.attention ? <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
                <span>
                  {delivery.explanation}{" "}
                  <a className="font-medium underline underline-offset-4" href="#communications">Emails</a>
                </span>
              </p>
            ) : null}
          </dl>
        ) : null}
        {blocker ? (
          <p className="text-muted-foreground" data-testid="client-access-blocker">
            {blocker.text}
            {blocker.link ? (
              <>
                {" "}
                <Link className="font-medium text-foreground underline" href={blocker.link.href}>{blocker.link.label}</Link>
              </>
            ) : null}
          </p>
        ) : (
          // Remounted for each new invitation, so the next send gets a new request id.
          <ActionForm
            key={i?.id ?? "none"}
            action={sendPlanningInvitation.bind(null, slug, eventId)}
            submitLabel={again ? "Send a new planning invitation" : "Send planning invitation"}
            pendingLabel="Sending…"
            variant={again ? "outline" : "default"}
            confirm={open ? "Send a new planning invitation? The link in the earlier email will stop working." : undefined}
          >
            <RequestIdField />
            <p className="text-muted-foreground [overflow-wrap:anywhere]">
              Emails {primary!.name} at <strong className="font-medium text-foreground">{primary!.email}</strong> a link to open planning
              {access.clientHasAccess ? "" : ", after confirming their email address"}. Review the planning first: they see what you set up.{" "}
              Wrong address? <Link className="underline" href={`/staff/${slug}/clients/${primary!.id}#details`}>Edit {primary!.name}</Link>.
            </p>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
