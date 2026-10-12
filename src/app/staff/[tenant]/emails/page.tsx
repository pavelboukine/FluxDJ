import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { deliveryState, emailPurpose, type Tone } from "@/lib/email/history";
import { cn } from "@/lib/utils";
import { processQueue, retryEmail } from "./actions";

const TONE: Record<Tone, string> = {
  normal: "border-border text-foreground",
  pending: "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200",
  good: "border-emerald-600/40 bg-emerald-600/10 text-emerald-900 dark:text-emerald-200",
  attention: "border-amber-600/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—");

/** Every email of this business, newest first, with what is actually known about its delivery (lib/email/history). */
export default async function EmailsPage({ params }: PageProps<"/staff/[tenant]/emails">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: emails } = await supabase
    .from("email_outbox")
    .select("id, event_type, recipient_email, status, attempts, max_attempts, last_error, next_attempt_at, sent_at, created_at, provider_status, provider_status_at, provider_detail, payload")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const now = new Date();
  const rows = (emails ?? []).map((e) => ({ e, purpose: emailPurpose(e), state: deliveryState(e, now) }));
  const attention = rows.filter((r) => r.state.attention).length;

  return (
    <>
      <PageHeader
        title="Email delivery"
        description="Every email is queued after the business change is saved, then delivered with automatic retries. Each event also shows its own emails."
      />
      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>
            {attention > 0 ? `${attention === 1 ? "1 email needs" : `${attention} emails need`} attention.` : "Nothing needs attention."} &ldquo;Accepted by email
            provider&rdquo; means it was handed over for delivery; only &ldquo;Delivered&rdquo; confirms the recipient&apos;s mail server took it.
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
          {rows.map(({ e, purpose, state }) => (
            <TableRow key={e.id} data-testid="email-row" data-status={e.status}>
              <TableCell className="align-top">
                {purpose.label}
                <div className="text-xs text-muted-foreground">{fmt(e.created_at)}</div>
                <div className="text-xs text-muted-foreground [overflow-wrap:anywhere] sm:hidden">{e.recipient_email}</div>
              </TableCell>
              <TableCell className="hidden align-top [overflow-wrap:anywhere] sm:table-cell">{e.recipient_email}</TableCell>
              <TableCell className="align-top">
                <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", TONE[state.tone])}>{state.label}</span>
                {state.retryable ? (
                  <div className="mt-2">
                    <ActionForm action={retryEmail.bind(null, slug, e.id)} submitLabel="Retry" variant="outline" inline>
                      <span />
                    </ActionForm>
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="hidden max-w-xs align-top text-xs whitespace-normal text-muted-foreground md:table-cell">
                {state.explanation}
                {state.at ? <div>{fmt(state.at)}</div> : null}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No emails yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
