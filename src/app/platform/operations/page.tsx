import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/app/fields";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { emailPurpose, type Tone } from "@/lib/email/history";
import { workerHealth } from "@/lib/operations";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Operations · Flux DJ", robots: { index: false, follow: false } };

const TONE: Record<Tone, string> = {
  normal: "border-border text-foreground",
  pending: "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200",
  good: "border-emerald-600/40 bg-emerald-600/10 text-emerald-900 dark:text-emerald-200",
  attention: "border-amber-600/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
};

const fmt = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date(iso)) : "—";

const short = (id: string) => id.slice(0, 8);

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE[tone])}>{children}</span>;
}

function Stat({ label, value, tone, hint, testId }: { label: string; value: number; tone: Tone; hint: string; testId: string }) {
  return (
    <div className="grid gap-1 rounded-lg border p-3" data-testid={testId} data-value={value}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div>
        <Pill tone={value > 0 ? tone : "good"}>{value > 0 ? hint : "None"}</Pill>
      </div>
    </div>
  );
}

const business = (slug: string | null, name: string | null) =>
  slug ? (
    <>
      {name}
      <div className="text-xs text-muted-foreground break-all">/{slug}</div>
    </>
  ) : (
    <span className="text-muted-foreground">Flux DJ (platform email)</span>
  );

/**
 * Platform operations: is the scheduled worker running, and which email and
 * signed-PDF jobs, across every business, need attention. Read-only. Ids,
 * businesses, categories, states, attempts, times and the database's
 * fixed-sentence error summaries only (raw error text never reaches this
 * page): never recipients, links, email contents or contract contents. Retrying stays where it was,
 * on each business's Emails and contract pages.
 */
export default async function Operations() {
  const { supabase } = await requirePlatformAdmin();
  const [summaryRes, emailRes, docRes] = await Promise.all([
    supabase.rpc("platform_operations_summary").single(),
    supabase.rpc("platform_email_issues", { p_limit: 50 }),
    supabase.rpc("platform_document_issues", { p_limit: 50 }),
  ]);
  if (summaryRes.error || emailRes.error || docRes.error) throw new Error("Platform operations could not be loaded.");
  const s = summaryRes.data;
  const health = workerHealth(s, new Date(s.checked_at));
  const emails = emailRes.data ?? [];
  const docs = docRes.data ?? [];

  return (
    <>
      <PageHeader
        title="Platform Operations"
        description={`Background work across every business: the scheduled worker, and emails and signed PDFs that need attention. Failures of the last ${s.window_days} days; overdue means more than ${s.grace_minutes} minutes past due. Checked ${fmt(s.checked_at)}.`}
      />

      <Card data-testid="worker-health" data-state={health.state}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Scheduled worker <Pill tone={health.attention ? "attention" : health.state === "ok" ? "good" : "normal"}>{health.label}</Pill>
          </CardTitle>
          <CardDescription>{health.explanation}</CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          This is the worker as a whole: a run without problems can still leave single emails retrying or failed. Those are counted below and shown on
          each business&apos;s Emails page.
        </CardContent>
      </Card>

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat testId="stat-emails-failed" label="Failed emails" value={Number(s.emails_failed)} tone="attention" hint="Needs a decision" />
        <Stat testId="stat-emails-possibly-delivered" label="Of which possibly delivered" value={Number(s.emails_possibly_delivered)} tone="attention" hint="Check before retrying" />
        <Stat testId="stat-emails-overdue" label="Overdue emails" value={Number(s.emails_overdue)} tone="attention" hint="Not being picked up" />
        <Stat testId="stat-emails-retrying" label="Emails retrying" value={Number(s.emails_retrying)} tone="pending" hint="Retried automatically" />
        <Stat testId="stat-documents-failed" label="Failed PDFs" value={Number(s.documents_failed)} tone="attention" hint="Needs a decision" />
        <Stat testId="stat-documents-overdue" label="Overdue PDFs" value={Number(s.documents_overdue)} tone="attention" hint="Not being picked up" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Emails needing attention</CardTitle>
          <CardDescription>
            Failed (every attempt used, or refused) and overdue emails, newest first, up to 50. Retry a failed email from its business&apos;s Emails page, after
            checking the email provider&apos;s log when it may already have been delivered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {emails.map((e) => (
                <TableRow key={e.id} data-testid="ops-email" data-issue={e.issue} data-id={e.id}>
                  <TableCell className="align-top">
                    {emailPurpose({ event_type: e.event_type, payload: {} }).label}
                    <div className="font-mono text-xs text-muted-foreground" title={e.id}>
                      {short(e.id)}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">{business(e.tenant_slug, e.tenant_name)}</TableCell>
                  <TableCell className="align-top">
                    <Pill tone={e.issue === "overdue" ? "pending" : "attention"}>
                      {e.issue === "overdue" ? "Overdue" : e.possibly_delivered ? "Possibly delivered" : "Failed"}
                    </Pill>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {e.attempts} of {e.max_attempts} attempts
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-sm align-top text-xs whitespace-normal text-muted-foreground md:table-cell">
                    {e.issue === "overdue" ? `Due since ${fmt(e.next_attempt_at)}; the worker hasn't picked it up.` : (e.error_summary ?? "Every attempt failed.")}
                    <div>Updated {fmt(e.updated_at)}</div>
                  </TableCell>
                </TableRow>
              ))}
              {emails.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No email needs attention.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Signed PDFs needing attention</CardTitle>
          <CardDescription>
            Failed and overdue signed-contract PDF jobs, newest first, up to 50. The signature itself is never affected. Request the PDF again from the
            business&apos;s contract page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contract</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id} data-testid="ops-document" data-issue={d.issue} data-id={d.id}>
                  <TableCell className="align-top">
                    <span className="font-mono text-xs" title={d.contract_id}>
                      {short(d.contract_id)}
                    </span>
                    <div className="font-mono text-xs text-muted-foreground" title={d.id}>
                      job {short(d.id)}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">{business(d.tenant_slug, d.tenant_name)}</TableCell>
                  <TableCell className="align-top">
                    <Pill tone={d.issue === "overdue" ? "pending" : "attention"}>{d.issue === "overdue" ? "Overdue" : "Failed"}</Pill>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {d.attempts} of {d.max_attempts} attempts
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-sm align-top text-xs whitespace-normal text-muted-foreground md:table-cell">
                    {d.issue === "overdue" ? `Due since ${fmt(d.next_attempt_at)}; the worker hasn't picked it up.` : (d.error_summary ?? "Every attempt failed.")}
                    <div>Updated {fmt(d.updated_at)}</div>
                  </TableCell>
                </TableRow>
              ))}
              {docs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No signed PDF needs attention.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
