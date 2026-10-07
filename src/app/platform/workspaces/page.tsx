import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { PageHeader, TextAreaField } from "@/components/app/fields";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { restoreWorkspace, suspendWorkspace } from "./actions";

export const metadata: Metadata = { title: "Workspaces · Flux DJ", robots: { index: false, follow: false } };

const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date(value)) : "";

/**
 * Workspace access administration: names, addresses, dates and suspension
 * details only. No clients, events, contracts, payments or planning.
 */
export default async function Workspaces() {
  const { supabase } = await requirePlatformAdmin();
  const { data: workspaces } = await supabase.rpc("platform_workspaces_overview");

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Suspend a DJ business's workspace, or restore it. Suspension blocks access without deleting anything; it is separate from archiving."
      />
      <Card>
        <CardHeader>
          <CardTitle>All workspaces</CardTitle>
        </CardHeader>
        <CardContent>
          {workspaces && workspaces.length > 0 ? (
            <ul className="grid gap-4 text-sm">
              {workspaces.map((w) => (
                <li key={w.id} className="grid gap-2 border-b pb-4 last:border-b-0 last:pb-0" data-testid="workspace">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{w.display_name}</span>
                    <span className="text-muted-foreground break-all">/{w.slug}</span>
                    <Badge variant={w.suspended_at ? "destructive" : "secondary"}>{w.suspended_at ? "Suspended" : "Active"}</Badge>
                    {w.archived_at ? <Badge variant="outline">Archived</Badge> : null}
                    {w.is_member ? <Badge variant="outline">Yours</Badge> : null}
                  </div>
                  <p className="text-muted-foreground">
                    Created {date(w.created_at)}
                    {w.archived_at ? ` · archived ${date(w.archived_at)}` : ""}
                  </p>
                  {w.suspended_at ? (
                    <p>
                      Suspended {date(w.suspended_at)}
                      {w.suspended_by_email ? ` by ${w.suspended_by_email}` : ""}. Internal reason: {w.suspension_reason ?? "not recorded"}
                    </p>
                  ) : null}
                  {/* Keyed by action and version: after every change the panel starts closed and empty. */}
                  {w.suspended_at ? (
                    <ConfirmPanel key={`restore-${w.suspension_version}`} label="Restore…" title={`Restore ${w.display_name} (/${w.slug})?`}>
                      <p>
                        Its owner, staff and clients get access back under the usual rules. Nothing is sent: emails cancelled by the suspension
                        stay cancelled, links and sessions that expired meanwhile stay expired, and planning deadlines don&apos;t move. Pending
                        signed PDFs are generated again.
                      </p>
                      <ActionForm action={restoreWorkspace.bind(null, w.id)} version={w.suspension_version} submitLabel="Restore workspace" pendingLabel="Restoring…">
                        <TextAreaField label="Internal reason" name="reason" required minLength={3} maxLength={500} rows={2} hint="Recorded in the platform audit history. Never shown to the business or its clients." />
                      </ActionForm>
                    </ConfirmPanel>
                  ) : w.is_member ? (
                    <p className="text-muted-foreground">You belong to this workspace, so it can&apos;t be suspended from your account.</p>
                  ) : (
                    <ConfirmPanel key={`suspend-${w.suspension_version}`} label="Suspend…" variant="destructive" title={`Suspend ${w.display_name} (/${w.slug})?`}>
                      <ul className="grid list-disc gap-1 pl-5">
                        <li>
                          Its owner and staff lose access to this workspace, and its clients lose access to its proposals, contracts, signing,
                          planning, payment summaries, files and PDFs. Open pages stop working on their next request.
                        </li>
                        <li>
                          Proposal links, contract invitations and sessions are blocked, not revoked. Their expiry dates keep running.
                        </li>
                        <li>
                          Emails waiting to be sent are cancelled and won&apos;t be sent after restoring. Signed-PDF generation waits until
                          restoration.
                        </li>
                        <li>
                          Nothing is deleted. Their sign-in and any other businesses or events they have on Flux DJ aren&apos;t affected. Emails
                          already sent and PDFs already downloaded can&apos;t be recalled.
                        </li>
                        <li>They see that the workspace is unavailable, never this reason or who suspended it.</li>
                      </ul>
                      <ActionForm action={suspendWorkspace.bind(null, w.id)} version={w.suspension_version} submitLabel="Suspend workspace" pendingLabel="Suspending…" variant="destructive">
                        <TextAreaField label="Internal reason" name="reason" required minLength={3} maxLength={500} rows={2} hint="Recorded in the platform audit history. Never shown to the business or its clients." />
                      </ActionForm>
                    </ConfirmPanel>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No workspaces.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
