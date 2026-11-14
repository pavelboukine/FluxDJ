import Link from "@/components/app/pending-link";
import { notFound } from "next/navigation";
import { ArrowRight, CheckCircle2, MailWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/app/fields";
import { InstallHelp } from "@/components/app/pwa";
import { requireStaff } from "@/lib/auth/staff";
import { ATTENTION_SHOWN, UPCOMING_SHOWN, attentionItems, dashboardSchema, deliveryFetchSince, deliveryProblems, shortDate, upcomingRows, withinDeliveryWindow } from "@/lib/dashboard";
import { GUIDANCE_WORKFLOWS, WORKFLOW_LABEL, isSetupGuidance, offerablePackages, reminders } from "@/lib/setup";
import { cn } from "@/lib/utils";

/** What's coming up and what needs attention. Read-only: viewing it changes nothing and sends nothing. */
export default async function Dashboard({ params, searchParams }: PageProps<"/staff/[tenant]">) {
  const { tenant: slug } = await params;
  const { welcome, attention } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  // Independent reads, all as the staff member under RLS, made together.
  const [{ data, error }, { data: problemRows }, { data: packages, error: packagesError }, { data: guidanceRow, error: guidanceError }] = await Promise.all([
    supabase.rpc("staff_dashboard", { p_tenant_id: tenant.id, p_upcoming_limit: UPCOMING_SHOWN }),
    // Provider-confirmed delivery problems (webhook events) of the last 30 days, under the staff RLS policy
    // (cut off by the database's clock below; see deliveryFetchSince). Newest first, so a response row
    // limit could only ever drop the extra day's rows, never the window's.
    supabase
      .from("email_outbox")
      .select("id, provider_status, provider_detail, provider_status_at")
      .eq("tenant_id", tenant.id)
      .in("provider_status", ["bounced", "failed", "suppressed", "complained"])
      .gte("provider_status_at", deliveryFetchSince(new Date()))
      .order("provider_status_at", { ascending: false }),
    // Active packages whose included gear is all active, as sending requires.
    supabase
      .from("packages")
      .select("package_items(gear_items!package_items_gear_item_fk(active))")
      .eq("tenant_id", tenant.id)
      .eq("active", true),
    // Which workflows the owner wants setup reminders about (guidance only).
    supabase.from("tenants").select("setup_guidance").eq("id", tenant.id).single(),
  ]);
  const parsed = dashboardSchema.safeParse(data);
  if (error || !parsed.success) {
    if (error?.code === "P0002") notFound(); // no longer a member (require_staff_of)
    throw new Error("The dashboard couldn't be loaded.");
  }
  const facts = parsed.data;
  const problems = deliveryProblems(withinDeliveryWindow(problemRows ?? [], facts.now));
  const isOwner = membership.role === "owner";
  const upcoming = upcomingRows(facts, slug);
  const tasks = attentionItems(facts, slug);
  const showAll = attention === "all";
  const shownTasks = showAll ? tasks : tasks.slice(0, ATTENTION_SHOWN);
  if (packagesError || guidanceError) throw new Error("The dashboard couldn't be loaded.");
  // Only the workflows the setup guidance covers; the card disappears once they have everything required.
  const guidance = isSetupGuidance(guidanceRow.setup_guidance) ? guidanceRow.setup_guidance : "proposals_and_contracts";
  const setup = reminders({ ...facts.setup, offerable_packages: offerablePackages(packages) }, slug, GUIDANCE_WORKFLOWS[guidance]);
  const welcoming = welcome === "1" && isOwner;
  const needs = setup.map((r) => WORKFLOW_LABEL[r.workflow].toLowerCase()).join(" and ");

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
              Create event
            </Link>
          </>
        }
      />
      <InstallHelp compact />

      {facts.failed_emails > 0 || problems.undelivered > 0 || problems.complaints > 0 ? (
        <p role="status" data-testid="email-failures" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <MailWarning aria-hidden className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          {facts.failed_emails > 0 ? (
            <span data-testid="email-send-failures">
              {facts.failed_emails === 1 ? "1 email couldn't be sent" : `${facts.failed_emails} emails couldn't be sent`} after several tries.
            </span>
          ) : null}
          {problems.undelivered > 0 ? (
            <span data-testid="email-undelivered">
              {problems.undelivered === 1 ? "1 email was rejected by the recipient's mail server" : `${problems.undelivered} emails were rejected by recipients' mail servers`} or
              not delivered.
            </span>
          ) : null}
          {problems.complaints > 0 ? (
            <span data-testid="email-complaints">{problems.complaints === 1 ? "1 recipient marked an email as spam." : `${problems.complaints} recipients marked emails as spam.`}</span>
          ) : null}
          <Link className="tap-target-y font-medium underline" href={`/staff/${slug}/emails`}>Review emails</Link>
        </p>
      ) : null}

      {setup.length > 0 ? (
        <Card size="sm" data-testid="setup-checklist">
          <CardHeader>
            <CardTitle>{welcoming ? `Welcome to Flux DJ, ${tenant.display_name}` : "Finish setting up"}</CardTitle>
            <CardDescription>
              {welcoming
                ? `Let's get your business ready. Here's what's still needed before you can send ${needs}; the setup guide also covers branding, gear and planning.`
                : `Still needed before you can send ${needs}:`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-x-6">
              {setup.map((r) => (
                <section key={r.workflow} aria-labelledby={`setup-reminder-${r.workflow}-label`} data-testid={`setup-reminder-${r.workflow}`} className="grid content-start gap-1.5 text-sm">
                  <p id={`setup-reminder-${r.workflow}-label`} className="text-xs font-medium text-muted-foreground">To send {WORKFLOW_LABEL[r.workflow].toLowerCase()}</p>
                  <ul className="grid gap-1.5">
                    {r.tasks.map((item) => (
                      <li key={item.key} data-testid={`setup-${item.key}`} data-done={item.done} className="grid min-w-0">
                        <Link className="tap-target-y justify-self-start font-medium underline-offset-4 hover:underline" href={item.href}>{item.label}</Link>
                        <span className="text-xs text-muted-foreground">
                          {item.ownerOnly && !isOwner ? "Only the owner can complete this. " : null}
                          {item.hint}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {/* Stacked below lg, clear of the button's 44px tap layer ([data-app-main]). */}
            <div className="flex flex-col items-start gap-3 lg:flex-row lg:items-center lg:gap-4">
              <Link className={buttonVariants({ size: "sm" })} href={`/staff/${slug}/setup`}>
                {welcome === "1" ? "Open the setup guide" : "Continue setup"}
                <ArrowRight aria-hidden />
              </Link>
              {isOwner ? (
                <Link className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground lg:min-h-0" href={`/staff/${slug}/setup#guidance`} data-testid="setup-guidance-link">
                  Not using {needs.replace(" and ", " or ")}? Choose your setup guidance
                </Link>
              ) : null}
            </div>
            {welcoming ? (
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
              <CheckCircle2 aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" />
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
                      "group grid gap-0.5 rounded-xl border bg-card px-3.5 py-3 text-sm transition-colors hover:bg-muted/50 active:bg-muted",
                      t.tone === "urgent" ? "border-amber-500/60 bg-amber-500/5" : null,
                    )}
                  >
                    <span className={cn("font-medium", t.tone === "urgent" ? "text-amber-800 dark:text-amber-300" : null)}>{t.reason}</span>
                    <span className="[overflow-wrap:anywhere] sm:truncate">{t.title} · {shortDate(t.eventDate)}</span>
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
            <Link className="tap-target-y text-sm font-medium underline-offset-4 hover:underline" href={showAll ? `/staff/${slug}#attention` : `/staff/${slug}?attention=all#attention`}>
              {showAll ? "Show fewer" : `Show all ${tasks.length}`}
            </Link>
          ) : null}
        </section>

        <section aria-labelledby="upcoming-heading" className="grid gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="upcoming-heading" className="text-base font-semibold">Upcoming events</h2>
            <Link className="tap-target-y text-sm font-medium underline-offset-4 hover:underline" href={`/staff/${slug}/events`}>View all events</Link>
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
                  <Link href={e.href} data-testid="upcoming-event" className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/50 active:bg-muted sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:items-center">
                    <span className="flex items-baseline gap-2 sm:grid sm:gap-0">
                      <span className="font-medium whitespace-nowrap">{e.date}</span>
                      {e.relative ? <span className="text-xs text-muted-foreground">{e.relative}</span> : null}
                    </span>
                    <span className="grid min-w-0">
                      <span className="font-medium [overflow-wrap:anywhere] sm:truncate">{e.title}</span>
                      <span className="text-muted-foreground [overflow-wrap:anywhere] sm:truncate">
                        {e.client_name ?? "No client yet"} · <span className={e.venue_name ? undefined : "italic"}>{e.venue}</span>
                      </span>
                    </span>
                    <span className="sm:justify-self-end">
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-auto whitespace-normal",
                          e.booked ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null,
                          e.external ? "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200" : null,
                        )}
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
