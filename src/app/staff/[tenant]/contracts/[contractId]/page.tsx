import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/fields";
import { ContractDocument } from "@/components/contract/contract-document";
import { requireStaff } from "@/lib/auth/staff";
import { CONTRACT_STATUS_LABEL, renderedContentSchema } from "@/lib/contracts/content";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { SentControls } from "./sent-controls";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Staff preview of a contract exactly as stored. Readable on a phone. */
export default async function ContractPreview({ params }: PageProps<"/staff/[tenant]/contracts/[contractId]">) {
  const { tenant: slug, contractId } = await params;
  if (!UUID_RE.test(contractId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: contract } = await supabase
    .from("contracts")
    .select(
      "id, status, created_at, sent_at, voided_at, void_reason, event_id, proposal_id, replaces_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, content_sha256, events!contracts_event_fk(title, event_date), proposals!contracts_proposal_fk(revision), proposal_approvals!contracts_approval_fk(approved_at), contract_template_versions!contracts_template_version_fk(version_number, contract_templates!contract_template_versions_template_fk(id, name))",
    )
    .eq("id", contractId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!contract) notFound();
  const content = renderedContentSchema.parse(contract.rendered_content);
  const [{ data: current }, { data: replacedBy }] = await Promise.all([
    supabase.from("contracts").select("id").eq("tenant_id", tenant.id).eq("event_id", contract.event_id).eq("status", "draft").maybeSingle(),
    supabase.from("contracts").select("id").eq("tenant_id", tenant.id).eq("replaces_id", contract.id).maybeSingle(),
  ]);
  const money = (cents: number) => formatCents(cents, contract.currency);
  const template = contract.contract_template_versions;
  const isDraft = contract.status === "draft";
  const isSent = contract.status === "sent";
  const { data: invitation } = await supabase
    .from("access_links")
    .select("id, created_at, expires_at, revoked_at, consumed_at")
    .eq("tenant_id", tenant.id)
    .eq("contract_id", contract.id)
    .eq("purpose", "contract")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <>
      <PageHeader
        title={`Contract for ${contract.events?.title ?? "event"}`}
        description={<><Link className="underline" href={`/staff/${slug}/events/${contract.event_id}`}>Back to event</Link> · <Link className="underline" href={`/staff/${slug}/proposals/${contract.proposal_id}`}>Approved proposal</Link></>}
        actions={
          <>
            <Badge variant={isDraft ? "secondary" : "outline"}>{CONTRACT_STATUS_LABEL[contract.status] ?? contract.status}</Badge>
            {isDraft ? (
              <Link className={buttonVariants()} href={`/staff/${slug}/contracts/${contract.id}/review`}>Review and send…</Link>
            ) : null}
          </>
        }
      />

      {isSent ? (
        <div role="status" className="grid gap-1 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm">
          <p className="font-medium">Sent {fmt(contract.sent_at!)} to {contract.signer_name} ({contract.signer_email}). Not signed; signing isn&apos;t available yet.</p>
          {invitation ? (
            <p className="text-muted-foreground">
              Latest invitation: sent {fmt(invitation.created_at)}, {invitation.revoked_at ? "revoked" : `valid until ${fmt(invitation.expires_at)}`}.
              {invitation.consumed_at ? ` The client confirmed their email and opened it ${fmt(invitation.consumed_at)}.` : " The client hasn't opened it with a confirmed email yet."}
            </p>
          ) : null}
        </div>
      ) : contract.status === "void" ? (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          Voided {fmt(contract.voided_at!)}: {contract.void_reason} The client can no longer read it. It was first sent {fmt(contract.sent_at!)}.
        </p>
      ) : isDraft ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Draft preview for staff. It has not been sent, the client cannot see it, and signing is not available yet.
        </p>
      ) : (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          {contract.status === "superseded"
            ? "A revised offer replaced the approval this draft was built from. It can't be used."
            : "This draft was replaced by a newer draft and can't be used."}{" "}
          {current ? <Link className="underline" href={`/staff/${slug}/contracts/${current.id}`}>Open the current draft</Link> : null}
          {!current && replacedBy ? <Link className="underline" href={`/staff/${slug}/contracts/${replacedBy.id}`}>Open the replacement</Link> : null}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="py-2">
            <ContractDocument title={content.title} sections={content.sections} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          {isSent ? (
            <Card>
              <CardHeader><CardTitle>Sent contract</CardTitle></CardHeader>
              <CardContent><SentControls slug={slug} contractId={contract.id} /></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Payment terms</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-1 text-sm">
                <div className="flex justify-between gap-2"><dt>Total, including taxes</dt><dd className="tabular-nums">{money(contract.total_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Deposit on signing ({contract.deposit_percent}%)</dt><dd className="tabular-nums">{money(contract.deposit_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Balance</dt><dd className="tabular-nums">{money(contract.balance_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Balance due</dt><dd>{contract.balance_due_date ?? "Not specified by this template"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Record</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm [overflow-wrap:anywhere]">
                <div><dt className="text-muted-foreground">Expected signer</dt><dd>{contract.signer_name} ({contract.signer_email})</dd></div>
                <div>
                  <dt className="text-muted-foreground">Template</dt>
                  <dd>
                    {template?.contract_templates ? (
                      <Link className="underline" href={`/staff/${slug}/contract-templates/${template.contract_templates.id}`}>{template.contract_templates.name}</Link>
                    ) : "Template"}{" "}
                    version {template?.version_number} (published, unchangeable)
                  </dd>
                </div>
                <div><dt className="text-muted-foreground">Approved selection</dt><dd>Proposal revision {contract.proposals?.revision}, approved {contract.proposal_approvals ? fmt(contract.proposal_approvals.approved_at) : ""}</dd></div>
                <div><dt className="text-muted-foreground">Generated</dt><dd>{fmt(contract.created_at)}</dd></div>
                {contract.replaces_id ? <div><dt className="text-muted-foreground">Replaces</dt><dd><Link className="underline" href={`/staff/${slug}/contracts/${contract.replaces_id}`}>Earlier draft</Link></dd></div> : null}
                <div>
                  <dt className="text-muted-foreground">Content SHA-256</dt>
                  <dd className="font-mono text-xs">{contract.content_sha256}</dd>
                  <dd className="text-xs text-muted-foreground">Identifies this exact text, terms and parties. Contract text and terms never change after generation.</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
