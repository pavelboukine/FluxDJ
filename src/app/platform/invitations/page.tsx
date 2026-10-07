import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { PageHeader } from "@/components/app/fields";
import { INVITATION_DAYS, requirePlatformAdmin } from "@/lib/auth/platform";
import { inviteDj, resendDjInvitation, revokeDjInvitation } from "./actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "DJ invitations · Flux DJ", robots: { index: false, follow: false } };

const STATE_LABEL = { pending: "Pending", expired: "Expired", accepted: "Accepted", revoked: "Revoked" } as const;
const DELIVERY_LABEL: Record<string, string> = { pending: "queued", sending: "sending", sent: "delivered to the provider", failed: "delivery failed", cancelled: "cancelled" };

const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date(value)) : "";

/** Platform administrators invite DJ business owners. Grants no access to any business's data. */
export default async function DjInvitations() {
  const { supabase } = await requirePlatformAdmin();
  const { data: invitations } = await supabase.rpc("platform_invitations_overview");

  return (
    <>
      <PageHeader
        title="DJ invitations"
        description="Invite a DJ business owner to create their own Flux DJ workspace. Only platform administrators see this page."
      />
      <Card>
        <CardHeader>
          <CardTitle>Invite a DJ</CardTitle>
          <CardDescription>
            The invitation link works for {INVITATION_DAYS} days and only for the invited address. You can resend it (a new link
            replaces the old one) or revoke it until it is accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteForm action={inviteDj} days={INVITATION_DAYS} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {invitations && invitations.length > 0 ? (
            <ul className="grid gap-4 text-sm">
              {invitations.map((i) => {
                const state = i.state as keyof typeof STATE_LABEL;
                const open = state === "pending" || state === "expired";
                return (
                  <li key={i.id} className="grid gap-2 border-b pb-4 last:border-b-0 last:pb-0" data-testid="dj-invitation">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{i.email}</span>
                      <Badge variant={state === "pending" ? "default" : state === "accepted" ? "secondary" : "outline"}>{STATE_LABEL[state] ?? i.state}</Badge>
                    </div>
                    <p className="text-muted-foreground">
                      {state === "accepted" ? (
                        <>Accepted {date(i.accepted_at)}: workspace <strong>{i.workspace_name}</strong> at /{i.workspace_slug}</>
                      ) : state === "revoked" ? (
                        <>Revoked {date(i.revoked_at)}</>
                      ) : (
                        <>
                          {state === "expired" ? "Expired" : "Expires"} {date(i.expires_at)} · sent {i.send_count} {i.send_count === 1 ? "time" : "times"}, last{" "}
                          {date(i.last_sent_at)}
                          {i.delivery_status ? ` · latest email ${DELIVERY_LABEL[i.delivery_status] ?? i.delivery_status}` : ""}
                        </>
                      )}
                    </p>
                    {open ? (
                      <div className="flex flex-wrap gap-2">
                        <ConfirmPanel label="Resend" title={`Send a new invitation link to ${i.email}?`}>
                          <p>The previous link stops working. The new one works for {INVITATION_DAYS} days.</p>
                          <ActionForm action={resendDjInvitation.bind(null, i.id)} submitLabel="Send a new link" pendingLabel="Sending…">
                            {null}
                          </ActionForm>
                        </ConfirmPanel>
                        <ConfirmPanel label="Revoke" variant="destructive" title={`Revoke the invitation for ${i.email}?`}>
                          <p>The link stops working and no workspace can be created with it. You can invite this address again later.</p>
                          <ActionForm action={revokeDjInvitation.bind(null, i.id)} submitLabel="Revoke invitation" pendingLabel="Revoking…" variant="destructive">
                            {null}
                          </ActionForm>
                        </ConfirmPanel>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No invitations yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
