import Link from "@/components/app/pending-link";
import { AlertTriangle } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { RequestIdField } from "@/components/app/request-id-field";
import type { StaffContext } from "@/lib/auth/staff";
import { deliveryState, type OutboxRow } from "@/lib/email/history";
import { invitationOpen, invitationStatus, type InvitationStatus, type PlanningAccess } from "@/lib/events/workspace";
import { cn } from "@/lib/utils";
import { openClientPlanning, sendPlanningInvitation } from "./client-access-actions";

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
 * elsewhere alike, as part of the Planning section (#client-access, below
 * its own planning links, so blockers name the step without repeating them).
 *
 * Preparing planning and opening it to the client are separate steps: until
 * staff open it, the client only sees that their DJ is getting it ready.
 * Opening is here only, and one-way:
 *  - "Open planning & send invitation" (send_planning_invitation opens it and
 *    queues the email in one transaction);
 *  - "Open without emailing" (open_client_planning), the secondary action.
 * Once open: who can open planning, the latest invitation's status and
 * recipient, and Send (a new) planning invitation; the invitation's dates and
 * delivery details behind a disclosure. Booking, setting up planning or
 * opening client editing never opens planning or sends anything. The database
 * checks every prerequisite again.
 */
export function ClientAccess({
  slug,
  eventId,
  access,
  email,
  booked,
  planningReady,
  editingOpen,
  opened,
  openedAt,
  openedBy,
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
  /** Staff opened planning to the client (event_plans.client_opened_at). */
  opened: boolean;
  openedAt: string | null;
  /** A staff email, "Former staff member", or "Flux DJ" (open before explicit opening existed). */
  openedBy: string | null;
  primary: { id: string; name: string; email: string; archived: boolean } | null;
  archived: boolean;
  external: boolean;
  fmt: (iso: string) => string;
}) {
  const now = new Date();
  const i = access.invitation;
  const invitationWorks = invitationOpen(i, now);
  const status = invitationStatus(i, email, now);
  const planningHref = `/staff/${slug}/events/${eventId}/planning`;
  // What stops planning being opened at all, then what stops an invitation email.
  const openBlocker: Blocker | null = archived
    ? { text: opened ? "Unarchive the event to invite the client." : "Unarchive the event to open planning to the client." }
    : !booked
      ? { text: opened ? "The event isn't booked yet. You can send a planning invitation once the booking is confirmed." : "The event isn't booked yet. You can open planning to the client once the booking is confirmed." }
      : !planningReady
        ? { text: opened ? "Set up planning before inviting your client." : "Set up planning before opening it to your client." }
        : null;
  const emailBlocker: Blocker | null = openBlocker
    ? openBlocker
    : !editingOpen
      ? {
          text: opened
            ? "Client editing is closed. Open it on the planning page before inviting your client, so they can fill planning in."
            : "Client editing is closed (by you or the deadline), so no invitation can be sent. Reopen it on the planning page first, or open planning without emailing: your client then reads it, read-only.",
          link: { label: "Planning page", href: planningHref },
        }
      : !primary || primary.archived
        ? { text: "Add an active primary contact to invite.", link: { label: "Contacts", href: "#contacts" } }
        : null;
  const delivery = email ? deliveryState(email, now) : null;
  const recipient = i ? <span data-testid="planning-invitation-recipient">{i.email}</span> : null;
  // Contract access alone (a Flux booking) isn't an invitation: the first one is still "Send planning invitation".
  const again = Boolean(i);
  // Not open yet; else the latest invitation's status, else whether the client can open planning without one (a Flux booking's contract access).
  const headline: InvitationStatus = !opened
    ? { label: "Not open yet", tone: "normal" }
    : i
      ? status
      : access.clientHasAccess
        ? { label: "Has access", tone: "good" }
        : status;

  return (
    <section id="client-access" aria-labelledby="client-access-heading" className="grid scroll-mt-20 gap-3 border-t pt-4" data-testid="client-access" data-opened={opened ? "true" : "false"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="client-access-heading" className="font-medium">Client access</h3>
        <span data-testid={opened && i ? "planning-invitation-status" : "client-access-headline"} className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", TONE[headline.tone])}>
          {headline.label}
        </span>
      </div>
      <p data-testid="client-access-state" className="[overflow-wrap:anywhere]">
        {!opened ? (
          <>
            Planning isn&apos;t open to your client yet: they see that you&apos;re getting it ready. Prepare it first, then open it when it&apos;s
            ready.
          </>
        ) : access.clientHasAccess ? (
          <>
            The client has verified access and can open planning (and edit it while client editing is open).
            {i ? <> Invited at {recipient}.</> : null}
          </>
        ) : i ? (
          invitationWorks ? (
            <>Planning invitation for {recipient}, created {fmt(i.createdAt)}. It works until {fmt(i.expiresAt)}; the client hasn&apos;t accepted it yet.</>
          ) : (
            <>
              The last planning invitation ({fmt(i.createdAt)}, to {recipient}){" "}
              {i.revoked ? "was replaced or cancelled" : i.stale ? "no longer works: the primary contact or their email changed" : "expired"}.
            </>
          )
        ) : (
          "Planning is open, but your client hasn't been invited yet."
        )}
      </p>
      {opened && openedAt ? (
        <p className="text-xs text-muted-foreground" data-testid="planning-opened">
          Opened to the client {fmt(openedAt)}
          {openedBy && openedBy !== "Flux DJ" ? <> by {openedBy}</> : null}.
        </p>
      ) : null}
      {opened && i ? (
        <div className="grid gap-2" data-testid="planning-invitation">
          {delivery?.attention && !i.accepted && !i.revoked ? (
            <p className="flex gap-1.5 text-amber-800 dark:text-amber-300">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {delivery.explanation} <a className="font-medium underline underline-offset-4" href="#communications">Emails</a>
              </span>
            </p>
          ) : null}
          <Disclosure id="invitation-details" summary="Invitation details">
            <dl className="grid gap-1.5">
              <Row label="Created">{fmt(i.createdAt)}</Row>
              {email?.sent_at ? <Row label="Sent">{fmt(email.sent_at)}</Row> : null}
              {i.acceptedAt ? <Row label="Accepted">{fmt(i.acceptedAt)}</Row> : null}
              <Row label="Works until">{fmt(i.expiresAt)}</Row>
            </dl>
            {delivery && !delivery.attention && !i.accepted && !i.revoked ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {delivery.explanation} <a className="font-medium underline underline-offset-4" href="#communications">Emails</a>
              </p>
            ) : null}
          </Disclosure>
        </div>
      ) : null}
      {emailBlocker ? <BlockerLine blocker={emailBlocker} /> : (
        // Remounted for each new invitation, so the next send gets a new request id.
        <ActionForm
          key={i?.id ?? "none"}
          action={sendPlanningInvitation.bind(null, slug, eventId)}
          submitLabel={!opened ? "Open planning & send invitation" : again ? "Send a new planning invitation" : "Send planning invitation"}
          pendingLabel={!opened ? "Opening…" : "Sending…"}
          variant={opened && again ? "outline" : "default"}
          confirm={
            !opened
              ? `Open planning to ${primary!.name} and email them an invitation? Opening can't be undone; you can still close client editing later.`
              : invitationWorks
                ? "Send a new planning invitation? The link in the earlier email will stop working."
                : undefined
          }
        >
          <RequestIdField />
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {!opened ? "Opens planning to your client and emails " : "Emails "}
            {primary!.name} at <strong className="font-medium text-foreground">{primary!.email}</strong> a link to planning
            {access.clientHasAccess ? "" : ", after confirming their email address"}. Nothing is sent until you do{external ? "" : ", not even when the event is booked"}.{" "}
            Wrong address? <Link className="underline" href={`/staff/${slug}/clients/${primary!.id}#details`}>Edit {primary!.name}</Link>.
          </p>
        </ActionForm>
      )}
      {!opened && !openBlocker ? (
        <div className="grid gap-2 rounded-xl border border-dashed p-3" data-testid="open-without-emailing">
          <ActionForm
            action={openClientPlanning.bind(null, slug, eventId)}
            submitLabel="Open without emailing"
            pendingLabel="Opening…"
            variant="outline"
            confirm="Open planning to your client without emailing them? Opening can't be undone; you can still close client editing later."
          >
            <p className="text-muted-foreground">
              {access.clientHasAccess
                ? "Your client can then open planning from their account, but isn't told it's ready. You can send the invitation later."
                : "Nobody is emailed, and your client has no access yet: send the planning invitation later so they can sign in."}
              {editingOpen ? "" : " Client editing is closed, so they would read it, read-only."}
            </p>
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}

function BlockerLine({ blocker }: { blocker: Blocker }) {
  return (
    <p className="text-muted-foreground" data-testid="client-access-blocker">
      {blocker.text}
      {blocker.link ? (
        <>
          {" "}
          <Link className="font-medium text-foreground underline" href={blocker.link.href}>{blocker.link.label}</Link>
        </>
      ) : null}
    </p>
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
