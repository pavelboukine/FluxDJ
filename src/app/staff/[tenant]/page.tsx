import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CheckCircle2, Circle, MailWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/fields";
import { InstallHelp } from "@/components/app/pwa";
import { requireStaff } from "@/lib/auth/staff";
import { ATTENTION_SHOWN, UPCOMING_SHOWN, attentionItems, dashboardSchema, setupChecklist, shortDate, upcomingRows } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

/** What's coming up and what needs attention. Read-only: viewing it changes nothing and sends nothing. */
export default async function Dashboard({ params, searchParams }: PageProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { welcome, attention } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data, error } = await supabase.rpc("staff_dashboard", { p_tenant_id: tenant.id, p_upcoming_limit: UPCOMING_SHOWN });
  const parsed = dashboardSchema.safeParse(data);
  if (error || !parsed.success) {
    if (error?.code === "P0002") notFound(); // no longer a member (require_staff_of)
    throw new Error("The dashboard couldn't be loaded.");
  }
  const facts = parsed.data;
  const isOwner = membership.role === "owner";
  const upcoming = upcomingRows(facts, slug);
  const tasks = attentionItems(facts, slug);
  const showAll = attention === "all";
  const shownTasks = showAll ? tasks : tasks.slice(0, ATTENTION_SHOWN);
  const setup = setupChecklist(facts, slug);
  const setupDone = setup.filter((s) => s.done).length;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What's coming up and what needs your attention."
        actions={
          <>
            <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/clients#add-client`}>
              Add client
            </Link>
            <Link className={buttonVariants()} href={`/staff/${slug}/events/new`}>
              New event
            </Link>
          </>
        }
      />
      <InstallHelp compact />

      {facts.failed_emails > 0 ? (
        <p role="status" data-testid="email-failures" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <MailWarning aria-hidden className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <span>
            {facts.failed_emails === 1 ? "1 email couldn't be delivered" : `${facts.failed_emails} emails couldn't be delivered`} after
            several tries.
          </span>
          <Link className="font-medium underline" href={`/staff/${slug}/emails`}>Review emails</Link>
        </p>
      ) : null}

      {setupDone < setup.length ? (
        <Card size="sm" data-testid="setup-checklist">
          <CardHeader>
            <CardTitle>{welcome === "1" && isOwner ? `Welcome to Flux DJ, ${tenant.display_name}` : "Finish setting up"}</CardTitle>
            <CardDescription>
              {setupDone} of {setup.length} done. This list checks what&apos;s saved; it doesn&apos;t review your terms or prices.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ul className="grid gap-1.5 sm:grid-cols-2 sm:gap-x-6">
              {setup.map((item) => (
                <li key={item.key} data-testid={`setup-${item.key}`} data-done={item.done} className="flex items-start gap-2">
                  {item.done ? (
                    <CheckCircle2 aria-label="Done" className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle aria-label="To do" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="grid min-w-0">
                    {item.done ? (
                      <span className="text-muted-foreground">{item.label}</span>
                    ) : (
                      <>
                        <Link className="font-medium underline-offset-4 hover:underline" href={item.href}>{item.label}</Link>
                        <span className="text-xs text-muted-foreground">
                          {item.ownerOnly && !isOwner ? "Only the owner can complete this. " : null}
                          {item.hint}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {welcome === "1" && isOwner ? (
              <p className="text-xs text-muted-foreground">
                Using Flux DJ from your phone&apos;s home screen? Sign in there with the code from the sign-in email: the home-screen app keeps
                its own sign-in, separate from your browser.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <section aria-labelledby="attention-heading" id="attention" className="grid scroll-mt-20 gap-3 lg:order-last">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="attention-heading" className="text-base font-semibold">Needs attention</h2>
            {tasks.length > 0 ? <span className="text-sm text-muted-foreground" data-testid="attention-count">{tasks.length}</span> : null}
          </div>
          {tasks.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="attention-empty">
              <CheckCircle2 aria-hidden className="size-4 text-emerald-600" />
              Nothing needs your attention right now.
            </p>
          ) : (
            <ul className="grid gap-2" data-testid="attention-list">
              {shownTasks.map((t) => (
                <li key={t.key}>
                  <Link
                    href={t.href}
                    data-testid="attention-item"
                    data-kind={t.kind}
                    className={cn(
                      "group grid gap-0.5 rounded-xl border bg-card px-3.5 py-3 text-sm transition-colors hover:bg-muted/50",
                      t.tone === "urgent" ? "border-amber-500/60 bg-amber-500/5" : null,
                    )}
                  >
                    <span className={cn("font-medium", t.tone === "urgent" ? "text-amber-800 dark:text-amber-300" : null)}>{t.reason}</span>
                    <span className="truncate">{t.title} · {shortDate(t.eventDate)}</span>
                    {t.detail ? <span className="text-xs text-muted-foreground">{t.detail}</span> : null}
                    <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-foreground/80 group-hover:text-foreground">
                      {t.action} <ArrowRight aria-hidden className="size-3" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {tasks.length > ATTENTION_SHOWN ? (
            <Link className="text-sm font-medium underline-offset-4 hover:underline" href={showAll ? `/staff/${slug}#attention` : `/staff/${slug}?attention=all#attention`}>
              {showAll ? "Show fewer" : `Show all ${tasks.length}`}
            </Link>
          ) : null}
        </section>

        <section aria-labelledby="upcoming-heading" className="grid gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="upcoming-heading" className="text-base font-semibold">Upcoming events</h2>
            <Link className="text-sm font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/events`}>View all events</Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="upcoming-empty">
              No upcoming events.{" "}
              <Link className="font-medium text-foreground underline" href={`/staff/${slug}/events/new`}>Create an event</Link>
            </p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="upcoming-list">
              {upcoming.map((e) => (
                <li key={e.id}>
                  <Link href={e.href} data-testid="upcoming-event" className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/50 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:items-center">
                    <span className="flex items-baseline gap-2 sm:grid sm:gap-0">
                      <span className="font-medium whitespace-nowrap">{e.date}</span>
                      {e.relative ? <span className="text-xs text-muted-foreground">{e.relative}</span> : null}
                    </span>
                    <span className="grid min-w-0">
                      <span className="truncate font-medium">{e.title}</span>
                      <span className="truncate text-muted-foreground">
                        {e.client_name ?? "No client yet"} · <span className={e.venue_name ? undefined : "italic"}>{e.venue}</span>
                      </span>
                    </span>
                    <span className="sm:justify-self-end">
                      <Badge
                        variant="outline"
                        className={cn("h-auto whitespace-normal", e.booked ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null)}
                      >
                        {e.status}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {facts.upcoming_more ? (
            <p className="text-xs text-muted-foreground">Showing the next {upcoming.length}. The Events page lists every event by date.</p>
          ) : null}
        </section>
      </div>
    </>
  );
}
