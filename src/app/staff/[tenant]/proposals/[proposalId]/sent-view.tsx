import Link from "next/link";
import { eventStatusLabel } from "@/lib/events/status";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { ProposalPreview } from "@/components/proposal/proposal-preview";
import { SelectionSummary } from "@/components/proposal/selection-summary";
import type { StaffContext } from "@/lib/auth/staff";
import { formatCents } from "@/lib/money";
import type { PricedSelection } from "@/lib/pricing";
import { LoadedContractCard } from "../../contracts/contract-card";
import { reviseProposal } from "../actions";
import { ApprovePanel } from "./approve-panel";
import { loadPreview, staffMediaBase } from "./load";

const EMAIL_LABEL: Record<string, string> = {
  proposal_sent: "Proposal email to client",
  proposal_link_opened: "Link-opened notice to you",
  proposal_submitted: "Submission notice to you",
  proposal_approved: "Approval acknowledgement to client",
  contract_sent: "Contract email to client",
  contract_sign_in: "Contract sign-in email to client",
  contract_voided: "Contract withdrawn notice to client",
};

const isPast = (iso: string | null) => iso !== null && Date.parse(iso) <= Date.now();

const fmt = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—";

/** Staff view of a sent (frozen) proposal: status, delivery, the exact submission, approval and revision. */
export async function SentProposalView({ staff, slug, proposalId }: { staff: StaffContext; slug: string; proposalId: string }) {
  const { supabase, tenant } = staff;
  const { data: p } = await supabase
    .from("proposals")
    .select("id, revision, status, sent_at, expires_at, first_viewed_at, events!proposals_event_fk(id, title, event_date, venue_name, lifecycle_status, active_proposal_id)")
    .eq("id", proposalId)
    .eq("tenant_id", tenant.id)
    .single();
  if (!p || !p.events) return null;
  const event = p.events;

  const [{ data: link }, { count: openings }, { data: selection }, { data: approval }, { data: emails }, { data: draft }, { count: signedCount }, preview] = await Promise.all([
    supabase.from("access_links").select("expires_at, revoked_at, clients!access_links_client_fk(name, email)").eq("proposal_id", p.id).eq("purpose", "proposal").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("proposal_views").select("id", { count: "exact", head: true }).eq("proposal_id", p.id),
    supabase.from("proposal_selections").select("id, version, submitted_at, total_cents, currency, selection_snapshot").eq("proposal_id", p.id).order("version", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("proposal_approvals").select("id, approved_at, selection_id").eq("proposal_id", p.id).maybeSingle(),
    supabase.from("email_outbox").select("id, event_type, recipient_email, status, attempts, last_error, sent_at").eq("entity_id", p.id).order("created_at"),
    supabase.from("proposals").select("id, revision").eq("event_id", event.id).eq("status", "draft").maybeSingle(),
    supabase.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("event_id", event.id).eq("status", "signed"),
    loadPreview(staff, p.id),
  ]);

  const active = event.active_proposal_id === p.id && p.status !== "superseded";
  const expired = p.status === "sent" && isPast(p.expires_at);
  const label = !active ? "Superseded" : expired ? "Expired" : ({ sent: "Sent", submitted: "Submitted for review", approved: "Approved" } as Record<string, string>)[p.status] ?? p.status;

  return (
    <>
      <PageHeader
        title={`Proposal for ${event.title}`}
        description={<><Link className="underline" href={`/staff/${slug}/events/${event.id}`}>Back to event</Link> · revision {p.revision} · {event.event_date}</>}
        actions={<Badge variant="outline">{label}</Badge>}
      />

      {!active ? (
        <Card>
          <CardContent className="text-sm">
            This revision was replaced by a newer offer. Its terms, submission and approval are kept as history.{" "}
            {event.active_proposal_id ? <Link className="underline" href={`/staff/${slug}/proposals/${event.active_proposal_id}`}>Open the current offer</Link> : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader><CardTitle>Status</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>Sent {fmt(p.sent_at)} to {link?.clients?.name} ({link?.clients?.email}).</p>
              <p>Offer deadline: {fmt(p.expires_at)}.{expired ? " The client can no longer change or submit it." : ""}</p>
              <p>
                Link opened: {p.first_viewed_at ? `first ${fmt(p.first_viewed_at)}, ${openings ?? 0} time(s)` : "not yet"}.
                <span className="block text-xs text-muted-foreground">
                  An opening only shows the link was used. Email scanners and previews can open links, so it is not proof the client read the proposal.
                </span>
              </p>
              <p>Client link: {link?.revoked_at ? "revoked" : "active"}. Event status: {eventStatusLabel(event.lifecycle_status, (signedCount ?? 0) > 0)} (not booked).</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Emails</CardTitle>
              <CardDescription>Delivery is retried automatically. <Link className="underline" href={`/staff/${slug}/emails`}>All emails</Link></CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-1 text-sm">
                {(emails ?? []).map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2">
                    <span>{EMAIL_LABEL[e.event_type] ?? e.event_type} · {e.recipient_email}</span>
                    <span className={e.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {e.status}{e.status === "sent" ? ` ${fmt(e.sent_at)}` : ""}{e.last_error && e.status !== "sent" ? ` (${e.last_error})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Client selection</CardTitle>
              <CardDescription>The exact immutable submission. Approval refers to this record.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {selection && preview.ok ? (
                <>
                  <p className="text-sm text-muted-foreground">Submitted {fmt(selection.submitted_at)} (version {selection.version}).</p>
                  <SelectionSummary offer={preview.offer} selection={selection.selection_snapshot as unknown as PricedSelection} />
                  {approval ? (
                    <p role="status" className="text-sm font-medium">
                      Approved {fmt(approval.approved_at)}. {active ? "Next: generate the contract draft." : "A newer offer replaced this approval."} The event is not booked.
                    </p>
                  ) : active && p.status === "submitted" ? (
                    <ApprovePanel slug={slug} proposalId={p.id} selectionId={selection.id} total={formatCents(selection.total_cents, selection.currency)} />
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
              )}
            </CardContent>
          </Card>

          {active && approval && p.status === "approved" ? (
            <LoadedContractCard staff={staff} slug={slug} eventId={event.id} approvalId={approval.id} />
          ) : null}

          {active ? (
            <Card>
              <CardHeader>
                <CardTitle>Change the offer</CardTitle>
                <CardDescription>
                  Sent terms never change. A revision starts from this offer; sending it replaces this one and the client reviews and submits again.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {draft ? (
                  <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/proposals/${draft.id}`}>
                    Continue revision {draft.revision}
                  </Link>
                ) : (
                  <ActionForm action={reviseProposal.bind(null, slug, event.id)} submitLabel="Start a revised offer" variant="outline" inline>
                    <span />
                  </ActionForm>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card className="content-start lg:sticky lg:top-4 lg:self-start">
          <CardHeader>
            <CardTitle>Frozen offer</CardTitle>
            <CardDescription>Exactly what the client received. Catalog changes do not affect it.</CardDescription>
          </CardHeader>
          <CardContent>
            {preview.ok ? (
              <ProposalPreview offer={preview.offer} mediaBase={staffMediaBase(slug, p.id)} logo={preview.logo} event={event} contained />
            ) : (
              <p className="text-sm">{preview.message}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
