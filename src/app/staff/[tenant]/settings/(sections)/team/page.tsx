import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { PageHeader } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { SettingsSection } from "../../settings-section";
import { cancelStaffInvitation, inviteStaff, removeStaffMember, resendStaffInvitation } from "./actions";
import { InviteStaffForm } from "./invite-staff-form";

export const metadata: Metadata = { title: "Team & access · Flux DJ" };

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
const DELIVERY_LABEL: Record<string, string> = { pending: "queued", sending: "sending", sent: "accepted by the email provider", failed: "delivery failed", cancelled: "not sent" };

const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "America/Toronto" }).format(new Date(value)) : "";

/** Matches the owner checks in the database functions; every other staff action is open to any active member. */
const PERMISSIONS = [
  {
    role: "Owner",
    intro: "Everything staff can do, and:",
    items: [
      "Change the business profile, branding, deposit, taxes, booking and planning defaults",
      "Publish contract templates for client use",
      "Go below the required deposit on a contract",
      "Invite and remove staff",
    ],
  },
  {
    role: "Staff",
    intro: "Day-to-day work, with settings read-only:",
    items: [
      "Manage events, clients and client planning",
      "Send proposals and contracts, and record payments",
      "Manage gear, packages, questions and templates",
    ],
  },
];

function Permissions() {
  return (
    <div className="grid gap-6 text-sm sm:grid-cols-2" data-testid="permissions">
      {PERMISSIONS.map(({ role, intro, items }) => (
        <div key={role} className="grid content-start gap-2">
          <div className="grid gap-0.5">
            <h3 className="font-medium">{role}</h3>
            <p className="text-muted-foreground">{intro}</p>
          </div>
          <ul className="grid gap-1.5">
            {items.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The business's team: members, invitations, and (for the owner) inviting and removing staff. */
export default async function TeamPage({ params, searchParams }: PageProps<"/staff/[tenant]/settings/team">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: members } = await supabase.from("tenant_memberships").select("role").eq("tenant_id", tenant.id).is("removed_at", null);
  const owners = (members ?? []).filter((m) => m.role === "owner").length;
  const staff = (members ?? []).length - owners;
  const accessRole = (
    <p data-testid="access-role" className="text-sm">
      You are {membership.role === "owner" ? "an owner" : "a staff member"} of {tenant.display_name}. This workspace has{" "}
      {owners === 1 ? "1 owner" : `${owners} owners`} and {staff === 1 ? "1 staff member" : `${staff} staff members`}.
    </p>
  );
  const roles = (
    <SettingsSection title="Permissions">
      <Permissions />
    </SettingsSection>
  );

  if (membership.role !== "owner") {
    return (
      <>
        <SetupReturn slug={slug} from={from} />
        <PageHeader title="Team & access" description={`Who works in ${tenant.display_name}'s workspace.`} />
        <SettingsSection title="Your access">
          {accessRole}
          <p className="text-sm text-muted-foreground">Only the owner can invite or remove team members.</p>
        </SettingsSection>
        {roles}
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
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="Team & access" description="Invite staff to work in this workspace, and remove access when they leave." />

      <SettingsSection title="Members">
        {accessRole}
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
      </SettingsSection>

      <SettingsSection
        id="invite"
        title="Invite staff"
        description={`They get an email from ${tenant.display_name} via Flux DJ. The link works for 7 days, only for that address, and they confirm the address before they get access. You can resend or cancel it until it's accepted.`}
      >
        <InviteStaffForm action={inviteStaff.bind(null, slug)} />
      </SettingsSection>

      <SettingsSection title="Invitations">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="team-invitations-empty">No pending invitations.</p>
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
      </SettingsSection>

      {roles}
    </>
  );
}
