import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import type { StaffContext } from "@/lib/auth/staff";
import { deliveryState, emailPurpose, type OutboxRow, type Tone } from "@/lib/email/history";
import { cn } from "@/lib/utils";
import { retryEmail } from "../../emails/actions";

type Row = OutboxRow & { entity_type: string; entity_id: string };

/**
 * This event's emails: everything queued for its proposals and contracts
 * (client emails and the team's own notices), from the outbox under the
 * staff RLS policy, so other businesses' rows can't appear. Team and
 * platform invitations are never here.
 */
export async function loadCommunications(staff: StaffContext, proposalIds: string[], contractIds: string[]): Promise<Row[]> {
  const ids = [...proposalIds, ...contractIds];
  if (ids.length === 0) return [];
  const { data, error } = await staff.supabase
    .from("email_outbox")
    .select("id, event_type, recipient_email, status, attempts, max_attempts, last_error, next_attempt_at, sent_at, created_at, provider_status, provider_status_at, provider_detail, payload, entity_type, entity_id")
    .eq("tenant_id", staff.tenant.id)
    .in("entity_type", ["proposal", "contract"])
    .in("entity_id", ids)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("The event's emails couldn't be loaded.");
  return data;
}

const TONE: Record<Tone, string> = {
  normal: "border-border text-foreground",
  pending: "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200",
  good: "border-emerald-600/40 bg-emerald-600/10 text-emerald-900 dark:text-emerald-200",
  attention: "border-amber-600/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date(iso)) : "";

export function CommunicationsCard({ slug, rows }: { slug: string; rows: Row[] }) {
  const now = new Date();
  const items = rows.map((row) => ({ row, purpose: emailPurpose(row), state: deliveryState(row, now) }));
  const attention = items.filter((i) => i.state.attention).length;
  return (
    <Card id="communications" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Emails</CardTitle>
        <CardDescription>
          What Flux sent for this event, newest first. &ldquo;Accepted by email provider&rdquo; means it was handed over for delivery;
          only &ldquo;Delivered&rdquo; confirms the recipient&apos;s mail server took it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {attention > 0 ? (
          <p role="status" data-testid="communications-attention" className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
            {attention === 1 ? "1 email needs your attention." : `${attention} emails need your attention.`}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="text-muted-foreground" data-testid="communications-empty">No emails for this event yet. They appear here once a proposal or contract is sent.</p>
        ) : (
          <ol className="divide-y rounded-lg border" data-testid="communications">
            {items.map(({ row, purpose, state }) => (
              <li key={row.id} data-testid="communication" data-type={row.event_type} data-status={row.status} data-provider-status={row.provider_status ?? ""}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-medium">{purpose.label}</span>
                      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {purpose.toTeam ? "To your team" : "To"} {row.recipient_email} · {when(state.at)}
                      </span>
                    </span>
                    <span data-testid="communication-status" className={cn("rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE[state.tone])}>
                      {state.label}
                    </span>
                  </summary>
                  <div className="grid gap-2 px-3 pb-3 text-xs text-muted-foreground">
                    <p className="text-sm text-foreground">{state.explanation}</p>
                    <p>
                      Queued {when(row.created_at)}
                      {row.sent_at ? ` · handed to the provider ${when(row.sent_at)}` : ""}
                      {row.provider_status_at && row.provider_status ? ` · provider update ${when(row.provider_status_at)}` : ""}
                      {row.attempts > 0 ? ` · ${row.attempts === 1 ? "1 attempt" : `${row.attempts} attempts`}` : ""}
                    </p>
                    <p>
                      {row.entity_type === "proposal" ? (
                        <Link className="font-medium text-foreground underline-offset-4 hover:underline" href={`/staff/${slug}/proposals/${row.entity_id}`}>Open the proposal</Link>
                      ) : (
                        <Link className="font-medium text-foreground underline-offset-4 hover:underline" href={`/staff/${slug}/contracts/${row.entity_id}`}>Open the contract</Link>
                      )}
                    </p>
                    {state.retryable ? (
                      <ActionForm action={retryEmail.bind(null, slug, row.id)} submitLabel="Retry this email" pendingLabel="Retrying…" variant="outline" inline>
                        <span className="text-xs">Retrying sends this same email again; nothing is regenerated.</span>
                      </ActionForm>
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
