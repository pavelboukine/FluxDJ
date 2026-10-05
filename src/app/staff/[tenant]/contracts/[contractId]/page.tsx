import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/fields";
import { ContractDocument } from "@/components/contract/contract-document";
import { requireStaff } from "@/lib/auth/staff";
import { CONTRACT_STATUS_LABEL, renderedContentSchema } from "@/lib/contracts/content";
import { SIGNING_MODE_LABELS, type SigningMode } from "@/lib/contracts/usage";
import { SIGNATURE_BUCKET } from "@/lib/contracts/signing";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { SentControls } from "./sent-controls";
import { SignedDocumentPanel, type Delivery, type PdfState } from "./signed-document-panel";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Staff preview of a contract exactly as stored. Readable on a phone. */
export default async function ContractPreview({ params }: PageProps<"/staff/[tenant]/contracts/[contractId]">) {
  const { tenant: slug, contractId } = await params;
  if (!UUID_RE.test(contractId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: contract } = await supabase
    .from("contracts")
    .select(
      "id, status, signing_mode, booking_policy, created_at, sent_at, signed_at, voided_at, void_reason, event_id, proposal_id, replaces_id, signer_name, signer_email, currency, total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, content_sha256, party_snapshot, events!contracts_event_fk(title, event_date, archived_at), proposals!contracts_proposal_fk(revision), proposal_approvals!contracts_approval_fk(approved_at), contract_template_versions!contracts_template_version_fk(version_number, contract_templates!contract_template_versions_template_fk(id, name))",
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
  const isSigned = contract.status === "signed";
  // Evidence is staff-readable (row-level security limits it to this tenant).
  const { data: signature } = isSigned
    ? await supabase
        .from("contract_signatures")
        .select("typed_name, signer_email, signed_at, signature_path, signature_sha256, signature_width, signature_height, content_sha256, consent_version, consent_text, user_agent, client_ip, client_ip_source")
        .eq("tenant_id", tenant.id)
        .eq("contract_id", contract.id)
        .maybeSingle()
    : { data: null };
  // Signed PDF, its job and the per-recipient signed-copy deliveries.
  const [{ data: document }, { data: job }, { data: deliveries }] = isSigned
    ? await Promise.all([
        supabase.from("contract_documents").select("pdf_sha256, byte_size, generated_at").eq("tenant_id", tenant.id).eq("contract_id", contract.id).eq("kind", "signed_contract").maybeSingle(),
        supabase.from("document_jobs").select("status, attempts, last_error").eq("tenant_id", tenant.id).eq("contract_id", contract.id).maybeSingle(),
        supabase.from("email_outbox").select("id, recipient_email, status, last_error, sent_at, payload").eq("tenant_id", tenant.id).eq("entity_id", contract.id).eq("event_type", "contract_signed_copy").order("created_at"),
      ])
    : [{ data: null }, { data: null }, { data: null }];
  const pdfState: PdfState = document
    ? { kind: "ready", pdfSha256: document.pdf_sha256, byteSize: document.byte_size, generatedAt: document.generated_at }
    : !job
      ? { kind: "none" }
      : job.status === "failed"
        ? { kind: "failed", attempts: job.attempts, lastError: job.last_error }
        : { kind: job.status === "running" ? "running" : "pending", attempts: job.attempts, lastError: job.last_error };
  const businessEmail = (contract.party_snapshot as { business?: { contact_email?: string | null } })?.business?.contact_email ?? null;
  const recipients = [
    { role: "client" as const, email: contract.signer_email.toLowerCase() },
    ...(businessEmail ? [{ role: "business" as const, email: businessEmail.toLowerCase() }] : []),
  ];
  const deliveryRows: Delivery[] = (deliveries ?? []).map((d) => ({
    id: d.id,
    role: (d.payload as { recipient_role?: string })?.recipient_role === "business" ? "business" : "client",
    email: d.recipient_email,
    status: d.status,
    lastError: d.last_error,
    sentAt: d.sent_at,
  }));

  // Two-minute link, allowed by the Storage policy for committed signatures of this tenant.
  const signatureUrl = signature
    ? ((await supabase.storage.from(SIGNATURE_BUCKET).createSignedUrl(signature.signature_path, 120)).data?.signedUrl ?? null)
    : null;
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
            <Badge variant={contract.signing_mode === "client_use" ? "default" : "outline"}>{SIGNING_MODE_LABELS[contract.signing_mode as SigningMode]}</Badge>
            {isDraft ? (
              <Link className={buttonVariants()} href={`/staff/${slug}/contracts/${contract.id}/review`}>Review and send…</Link>
            ) : null}
          </>
        }
      />

      {contract.signing_mode === "none" && (isDraft || isSent) ? (
        <p role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This contract was generated from a template version published before agreements could be approved for client use, so it
          can&apos;t be signed online{isDraft ? " or sent" : ""}. Publish a version for client use in{" "}
          <Link className="underline" href={`/staff/${slug}/contract-templates`}>Contract templates</Link>, then{" "}
          {isSent ? "void this contract and generate a replacement" : "regenerate the contract"} from the{" "}
          <Link className="underline" href={`/staff/${slug}/events/${contract.event_id}`}>event</Link>.
        </p>
      ) : null}

      {isSigned ? (
        <div role="status" className="grid gap-1 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm">
          <p className="font-medium">
            Signed {fmt(contract.signed_at!)} by {signature?.typed_name ?? contract.signer_name} ({signature?.signer_email ?? contract.signer_email}).
          </p>
          <p className="text-muted-foreground">
            The signed agreement and its evidence can&apos;t be changed, voided or replaced, and the proposal can&apos;t be revised. The event is not
            marked booked by signing.
          </p>
        </div>
      ) : isSent ? (
        <div role="status" className="grid gap-1 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm">
          <p className="font-medium">Sent {fmt(contract.sent_at!)} to {contract.signer_name} ({contract.signer_email}). Not signed yet.</p>
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
          {isSigned ? (
            <Card>
              <CardHeader><CardTitle>Signed PDF</CardTitle></CardHeader>
              <CardContent>
                <SignedDocumentPanel
                  slug={slug}
                  contractId={contract.id}
                  pdf={pdfState}
                  deliveries={deliveryRows}
                  recipients={recipients}
                  archived={Boolean(contract.events?.archived_at)}
                />
              </CardContent>
            </Card>
          ) : null}
          {signature ? (
            <Card>
              <CardHeader><CardTitle>Signature and evidence</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid gap-2 text-sm [overflow-wrap:anywhere]">
                  {signatureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimizable asset
                    <img src={signatureUrl} alt={`Signature of ${signature.typed_name}`} className="h-24 w-auto max-w-full rounded border bg-white" />
                  ) : null}
                  <div><dt className="text-muted-foreground">Typed name</dt><dd>{signature.typed_name}</dd></div>
                  <div><dt className="text-muted-foreground">Verified signer email</dt><dd>{signature.signer_email}</dd></div>
                  <div><dt className="text-muted-foreground">Signed (server time)</dt><dd>{fmt(signature.signed_at)}</dd></div>
                  <div>
                    <dt className="text-muted-foreground">Contract signed</dt>
                    <dd className="font-mono text-xs">{signature.content_sha256}</dd>
                    <dd className="text-xs text-muted-foreground">{signature.content_sha256 === contract.content_sha256 ? "Matches this contract's content SHA-256." : "Does not match this contract."}</dd>
                  </div>
                  <div><dt className="text-muted-foreground">Signature image SHA-256</dt><dd className="font-mono text-xs">{signature.signature_sha256}</dd><dd className="text-xs text-muted-foreground">PNG, {signature.signature_width} × {signature.signature_height}</dd></div>
                  <div><dt className="text-muted-foreground">Consent ({signature.consent_version})</dt><dd>{signature.consent_text}</dd></div>
                  <div><dt className="text-muted-foreground">IP address</dt><dd>{signature.client_ip_source === "vercel" ? String(signature.client_ip) : "Not available (not reliably known for this request)"}</dd></div>
                  <div><dt className="text-muted-foreground">Browser</dt><dd className="text-xs">{signature.user_agent ?? "Not provided"}</dd></div>
                </dl>
              </CardContent>
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
                <div>
                  <dt className="text-muted-foreground">Booking</dt>
                  <dd>
                    {contract.booking_policy === "on_signature"
                      ? "Confirmed automatically when signed"
                      : contract.booking_policy === "on_deposit"
                        ? "Confirmed automatically when signed and the deposit is received"
                        : "Generated before booking policies: checked by staff on the event page"}
                  </dd>
                </div>
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
