import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { PageHeader } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { requireStaff } from "@/lib/auth/staff";
import { cancelStaffInvitation, inviteStaff, removeStaffMember, resendStaffInvitation } from "./actions";
import { InviteStaffForm } from "./invite-staff-form";

export const metadata: Metadata = { title: "Team · Flux DJ" };

type Member = { membership_id: string; email: string; role: "owner" | "staff"; joined_at: string; removed_at: string | null; is_you: boolean };
type Invitation = {
  id: string;
  email: string;
  state: "pending" | "expired" | "accepted" | "cancelled";
  created_at: string;
  expires_at: string;
  last_sent_at: string;
  send_count: number;
  accepted_at: string | null;
  revoked_at: string | null;
  delivery_status: string | null;
};

const STATE_LABEL = { pending: "Pending", expired: "Expired", accepted: "Accepted", cancelled: "Cancelled" } as const;
const DELIVERY_LABEL: Record<string, string> = { pending: "queued", sending: "sending", sent: "sent", failed: "delivery failed", cancelled: "not sent" };

const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "America/Toronto" }).format(new Date(value)) : "";

function Permissions() {
  return (
    <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
      <li><span className="text-foreground">Staff</span> work with events, clients, proposals, contracts, payments and planning, and with the catalog and templates.</li>
      <li><span className="text-foreground">The owner</span> also changes business settings, branding and taxes, publishes contracts for client use, and manages the team.</li>
      <li>Clients never see your team; they only see their own events.</li>
    </ul>
  );
}

/** The business's team: members, invitations, and (for the owner) inviting and removing staff. */
export default async function TeamPage({ params }: PageProps<"/staff/[tenant]/team">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, membership } = await requireStaff(slug);

  if (membership.role !== "owner") {
    return (
      <>
        <PageHeader title="Team" description={`Who works in ${tenant.display_name}'s workspace.`} />
        <Card>
          <CardContent className="grid gap-3 text-sm">
            <p data-testid="team-own-role">You are a <strong>staff member</strong> of {tenant.display_name}.</p>
            <Permissions />
            <p className="text-muted-foreground">Only the owner can invite or remove team members.</p>
          </CardContent>
        </Card>
      </>
    );
  }

  const { data, error } = await supabase.rpc("staff_team_overview", { p_tenant_id: tenant.id });
  if (error) {
    if (error.code === "P0002") notFound();
    throw new Error("The team couldn't be loaded.");
  }
  const overview = data as { members: Member[]; invitations: Invitation[] };
  const active = overview.members.filter((m) => !m.removed_at);
  const removed = overview.members.filter((m) => m.removed_at);
  const open = overview.invitations.filter((i) => i.state === "pending" || i.state === "expired");
  const closed = overview.invitations.filter((i) => i.state === "accepted" || i.state === "cancelled");

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite staff to work in this workspace, and remove access when they leave."
        actions={<Link className="text-sm font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/settings#access`}>Back to settings</Link>}
      />

      <Card id="invite">
        <CardHeader>
          <CardTitle>Invite staff</CardTitle>
          <CardDescription>
            They get an email from {tenant.display_name} via Flux DJ. The link works for 7 days and only for that address; they confirm the
            address before they get access. You can resend or cancel it until it&apos;s accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteStaffForm action={inviteStaff.bind(null, slug)} />
        </CardContent>
      </Card>

      <section aria-labelledby="members-heading" className="grid gap-3">
        <h2 id="members-heading" className="text-base font-semibold">Members</h2>
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="team-members">
          {active.map((m) => (
            <li key={m.membership_id} data-testid="team-member" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm">
              <div className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium [overflow-wrap:anywhere]">{m.email}</span>
                  {m.is_you ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                </span>
                <span className="text-muted-foreground">
                  {m.role === "owner" ? "Owner" : "Staff"} · Active · joined {date(m.joined_at)}
                </span>
              </div>
              {m.role === "staff" ? (
                <ConfirmPanel label="Remove" variant="destructive" title={`Remove ${m.email} from ${tenant.display_name}?`}>
                  <p>
                    They lose access to this business on their next click, even if they&apos;re signed in now. Everything they worked on stays,
                    with their name on it. Their Flux DJ account, other businesses and client events are unchanged. You can invite them again later.
                  </p>
                  <ActionForm action={removeStaffMember.bind(null, slug, m.membership_id)} submitLabel="Remove access" pendingLabel="Removing…" variant="destructive">
                    {null}
                  </ActionForm>
                </ConfirmPanel>
              ) : null}
            </li>
          ))}
        </ul>
        {removed.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Former staff ({removed.length})</summary>
            <ul className="mt-2 grid gap-1" data-testid="team-removed">
              {removed.map((m) => (
                <li key={m.membership_id} className="[overflow-wrap:anywhere]">
                  {m.email} <span className="text-muted-foreground">· removed {date(m.removed_at)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="invitations-heading" className="grid gap-3">
        <h2 id="invitations-heading" className="text-base font-semibold">Invitations</h2>
        {open.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="team-invitations-empty">No pending invitations.</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="team-invitations">
            {open.map((i) => (
              <li key={i.id} data-testid="team-invitation" data-state={i.state} className="grid gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium [overflow-wrap:anywhere]">{i.email}</span>
                  <Badge variant={i.state === "pending" ? "secondary" : "outline"}>{STATE_LABEL[i.state]}</Badge>
                </div>
                <p className="text-muted-foreground">
                  Invited {date(i.created_at)} · {i.state === "expired" ? "expired" : "expires"} {date(i.expires_at)}
                  {i.send_count > 1 ? ` · sent ${i.send_count} times` : ""}
                  {i.delivery_status ? ` · latest email ${DELIVERY_LABEL[i.delivery_status] ?? i.delivery_status}` : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <ConfirmPanel label="Resend" title={`Send a new invitation link to ${i.email}?`}>
                    <p>The previous link stops working. The new one works for 7 days.</p>
                    <ActionForm action={resendStaffInvitation.bind(null, slug, i.id)} submitLabel="Send a new link" pendingLabel="Sending…">
                      <RequestIdField />
                    </ActionForm>
                  </ConfirmPanel>
                  <ConfirmPanel label="Cancel invitation" variant="destructive" title={`Cancel the invitation for ${i.email}?`}>
                    <p>The link stops working at once and can&apos;t be used to join. You can invite this address again later.</p>
                    <ActionForm action={cancelStaffInvitation.bind(null, slug, i.id)} submitLabel="Cancel invitation" pendingLabel="Cancelling…" variant="destructive">
                      {null}
                    </ActionForm>
                  </ConfirmPanel>
                </div>
              </li>
            ))}
          </ul>
        )}
        {closed.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Recent history ({closed.length})</summary>
            <ul className="mt-2 grid gap-1" data-testid="team-invitation-history">
              {closed.map((i) => (
                <li key={i.id} className="[overflow-wrap:anywhere]">
                  {i.email} <span className="text-muted-foreground">· {STATE_LABEL[i.state].toLowerCase()} {date(i.accepted_at ?? i.revoked_at)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="roles-heading" className="grid gap-2">
        <h2 id="roles-heading" className="text-base font-semibold">What each role can do</h2>
        <Permissions />
      </section>
    </>
  );
}
