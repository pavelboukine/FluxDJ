import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { processQueue, retryEmail } from "./actions";

const LABEL: Record<string, string> = {
  proposal_sent: "Proposal",
  contract_sent: "Contract",
  contract_sign_in: "Contract sign-in link",
  contract_voided: "Contract withdrawn notice",
  contract_signed_copy: "Signed contract copy (PDF attached)",
  proposal_link_opened: "Link opened (best effort)",
  proposal_submitted: "Submitted for review",
  proposal_approved: "Approval acknowledgement",
};

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");

export default async function EmailsPage({ params }: PageProps<"/staff/[tenant]/emails">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: emails } = await supabase
    .from("email_outbox")
    .select("id, event_type, recipient_email, status, attempts, max_attempts, last_error, next_attempt_at, sent_at, created_at")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const failed = (emails ?? []).filter((e) => e.status === "failed").length;

  return (
    <>
      <PageHeader title="Email delivery" description="Every email is queued after the business change is saved, then delivered with automatic retries." />
      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>
            {failed > 0 ? `${failed} email(s) failed and need attention.` : "No failed emails."} Pending emails are delivered right after each action and
            by the background worker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={processQueue.bind(null, slug)} submitLabel="Deliver due emails now" variant="outline" inline>
            <span />
          </ActionForm>
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead className="hidden sm:table-cell">To</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(emails ?? []).map((e) => (
            <TableRow key={e.id}>
              <TableCell>
                {LABEL[e.event_type] ?? e.event_type}
                <div className="text-xs text-muted-foreground">{fmt(e.created_at)}</div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">{e.recipient_email}</TableCell>
              <TableCell>
                <Badge variant={e.status === "failed" ? "destructive" : e.status === "sent" ? "secondary" : "outline"}>{e.status}</Badge>
                {e.status === "failed" ? (
                  <div className="mt-2">
                    <ActionForm action={retryEmail.bind(null, slug, e.id)} submitLabel="Retry" variant="outline" inline>
                      <span />
                    </ActionForm>
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                {e.status === "sent" ? `Sent ${fmt(e.sent_at)}` : `Attempt ${e.attempts} of ${e.max_attempts}`}
                {e.status === "pending" && e.attempts > 0 ? ` · next try ${fmt(e.next_attempt_at)}` : ""}
                {e.last_error && e.status !== "sent" ? <div className="text-destructive">{e.last_error}</div> : null}
              </TableCell>
            </TableRow>
          ))}
          {emails?.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No emails yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
