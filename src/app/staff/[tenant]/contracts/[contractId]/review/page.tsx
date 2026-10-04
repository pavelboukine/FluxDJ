import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/fields";
import { ContractDocument } from "@/components/contract/contract-document";
import { requireStaff } from "@/lib/auth/staff";
import { renderedContentSchema } from "@/lib/contracts/content";
import { describeDbError } from "@/lib/db-errors";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { SendPanel } from "./send-panel";

type Review = {
  status: string;
  sent_at: string | null;
  eligible: boolean;
  problems: { code: string; message: string }[];
  can_send: boolean;
  send_unavailable_reason: string | null;
  signer: { name: string; email: string };
  business: { legal_name?: string | null; name?: string; address?: string | null; contact_email?: string | null; display_name?: string };
  deposit_percent: number;
  deposit_cents: number;
  balance_cents: number;
  total_cents: number;
  currency: string;
  balance_due_date: string | null;
  content_sha256: string;
};

/**
 * Review before sending: exactly what the client would receive, and the
 * server's eligibility checks (private.contract_send_problems, the same checks
 * the send transaction will run). Sending itself is not available yet.
 */
export default async function ReviewContract({ params }: PageProps<"/staff/[tenant]/contracts/[contractId]/review">) {
  const { tenant: slug, contractId } = await params;
  if (!UUID_RE.test(contractId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, event_id, rendered_content, events!contracts_event_fk(title)")
    .eq("id", contractId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!contract) notFound();
  const { data, error } = await supabase.rpc("review_contract_for_send", { p_contract_id: contract.id });
  if (error) {
    return <p role="alert" className="text-sm text-destructive">{describeDbError(error)}</p>;
  }
  const review = data as unknown as Review;
  const content = renderedContentSchema.parse(contract.rendered_content);
  const money = (cents: number) => formatCents(cents, review.currency);
  const business = review.business;

  return (
    <>
      <PageHeader
        title="Review contract before sending"
        description={<><Link className="underline" href={`/staff/${slug}/contracts/${contract.id}`}>Back to the contract</Link> · {contract.events?.title}</>}
        actions={review.status === "sent" ? <Badge variant="secondary">Sent</Badge> : review.eligible ? <Badge variant="secondary">Ready to send</Badge> : <Badge variant="outline">Not ready</Badge>}
      />

      {review.problems.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="font-medium">This contract can&apos;t be sent as it is:</p>
          <ul className="list-disc pl-5">
            {review.problems.map((p) => <li key={p.code} data-code={p.code}>{p.message}</li>)}
          </ul>
        </div>
      ) : (
        <p role="status" className="rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm">
          All checks pass: the signer, business details and deposit setting still match this contract.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Exactly what the client will receive</CardTitle>
            <CardDescription className="[overflow-wrap:anywhere]">Frozen contract, SHA-256 {review.content_sha256}</CardDescription>
          </CardHeader>
          <CardContent>
            <ContractDocument title={content.title} sections={content.sections} headingLevel={2} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader><CardTitle>Recipient</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm [overflow-wrap:anywhere]">
                <div><dt className="text-muted-foreground">Intended signer</dt><dd>{review.signer.name}</dd></div>
                <div><dt className="text-muted-foreground">Recipient email</dt><dd>{review.signer.email}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Business identity</CardTitle><CardDescription>As frozen in this contract.</CardDescription></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm [overflow-wrap:anywhere]">
                <div><dt className="text-muted-foreground">Legal name</dt><dd>{business.legal_name ?? business.name ?? "Not recorded"}</dd></div>
                <div><dt className="text-muted-foreground">Address</dt><dd className="whitespace-pre-wrap">{business.address ?? "Not recorded"}</dd></div>
                <div><dt className="text-muted-foreground">Contact email</dt><dd>{business.contact_email ?? "Not recorded"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Payment terms</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-1 text-sm">
                <div className="flex justify-between gap-2"><dt>Total, including taxes</dt><dd className="tabular-nums">{money(review.total_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Deposit on signing ({review.deposit_percent}%)</dt><dd className="tabular-nums">{money(review.deposit_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Balance</dt><dd className="tabular-nums">{money(review.balance_cents)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Balance due</dt><dd>{review.balance_due_date ?? "Not specified by this template"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Send</CardTitle></CardHeader>
            <CardContent>
              <SendPanel slug={slug} contractId={contract.id} canSend={review.can_send} reason={review.send_unavailable_reason} recipient={review.signer.email} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
