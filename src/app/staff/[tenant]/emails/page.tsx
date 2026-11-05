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

/* One table: from md a table, below md each email is a stacked block, so nothing needs sideways scrolling. */
const stackedCell = "max-md:block max-md:px-0 max-md:py-0 max-md:whitespace-normal";

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
      <Table className="max-md:block">
        <TableHeader className="max-md:hidden">
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>To</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-md:block">
          {rows.map(({ e, purpose, state }) => (
            <TableRow key={e.id} data-testid="email-row" data-status={e.status} className="max-md:grid max-md:gap-2 max-md:py-3 max-md:hover:bg-transparent">
              <TableCell className={cn(stackedCell, "align-top")}>
                {purpose.label}
                <div className="text-xs text-muted-foreground">{fmt(e.created_at)}</div>
                <div className="text-xs text-muted-foreground [overflow-wrap:anywhere] md:hidden" data-testid="email-recipient">{e.recipient_email}</div>
              </TableCell>
              <TableCell className="align-top [overflow-wrap:anywhere] max-md:hidden md:whitespace-normal xl:whitespace-nowrap">{e.recipient_email}</TableCell>
              <TableCell className={cn(stackedCell, "align-top max-md:flex max-md:min-h-8 max-md:items-center max-md:justify-between max-md:gap-2")}>
                <span data-testid="email-status" className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", TONE[state.tone])}>{state.label}</span>
                {state.retryable ? (
                  <div className="md:mt-2">
                    <ActionForm action={retryEmail.bind(null, slug, e.id)} submitLabel="Retry" variant="outline" inline>
                      <span />
                    </ActionForm>
                  </div>
                ) : null}
              </TableCell>
              <TableCell data-testid="email-details" className={cn(stackedCell, "max-w-xs align-top text-xs whitespace-normal text-muted-foreground max-md:max-w-none")}>
                {state.explanation}
                {state.at ? <div>{fmt(state.at)}</div> : null}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 ? <TableRow className="max-md:block max-md:py-3"><TableCell colSpan={4} className={cn(stackedCell, "text-muted-foreground")}>No emails yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
