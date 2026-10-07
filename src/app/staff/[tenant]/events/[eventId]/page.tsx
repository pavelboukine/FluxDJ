import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { CheckboxField, SelectField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { shortDate } from "@/lib/dates";
import { eventStatusLabel } from "@/lib/events/status";
import {
  contractSummary,
  currentProposals,
  nextAction,
  paymentOverview,
  planningLine,
  planningSummary,
  proposalSummary,
  type NextAction,
  type Summary,
  type WorkspaceFacts,
} from "@/lib/events/workspace";
import { UUID_RE } from "@/lib/forms";
import { cn } from "@/lib/utils";
import { ContractCard, loadContracts } from "../../contracts/contract-card";
import { addEventContact, openProposalDraft, removeEventContact, updateEvent } from "../actions";
import { EventFields } from "../event-fields";
import { EVENT_TYPES } from "../event-form";
import { ArchivePanel } from "./archive-panel";
import { PaymentsCard, loadPayments } from "./payments-card";
import { PlanningCard, loadPlanning } from "./planning-card";
import { RemoveContact } from "./remove-contact";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(new Date(iso));
const TYPE_LABEL = Object.fromEntries(EVENT_TYPES) as Record<string, string>;
const PROPOSAL_STATUS: Record<string, string> = {
  draft: "draft",
  sent: "sent",
  submitted: "submitted",
  approved: "approved",
  expired: "expired",
  declined: "declined",
  superseded: "replaced by a revision",
};

/**
 * The staff event workspace: what the event is, the recommended next step,
 * short summaries of proposal, contract, payments and planning, then the
 * sections where each is handled. Rendering only reads: it never sets up a
 * plan, books, or changes anything. Every action stays on its existing
 * screen or form, with the database checking eligibility.
 */
export default async function EventPage({ params, searchParams }: PageProps<"/staff/[tenant]/events/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  const { contact } = await searchParams;
  if (!UUID_RE.test(eventId)) notFound();
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const [{ data: event }, { data: clients }, { data: templates }, { data: identity }, contracts, payments, planning] = await Promise.all([
    supabase
      .from("events")
      .select("id, title, event_type, event_date, timezone, venue_name, venue_address, internal_notes, lifecycle_status, active_proposal_id, archived_at, event_clients(id, is_primary, can_sign, clients(id, name, email, archived_at)), proposals!proposals_event_fk(id, revision, status, offer_frozen_at, updated_at, expires_at)")
      .eq("id", eventId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.from("clients").select("id, name, email").eq("tenant_id", tenant.id).is("archived_at", null).order("name"),
    supabase.from("proposal_templates").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name"),
    supabase.from("tenants").select("business_address, contact_email").eq("id", tenant.id).single(),
    loadContracts(staff, eventId),
    loadPayments(staff, eventId),
    loadPlanning(staff, eventId),
  ]);
  if (!event) notFound();
  // The current approval, if the active proposal is approved; contracts are generated from it.
  const activeApproved = event.proposals.find((p) => p.id === event.active_proposal_id && p.status === "approved");
  const { data: approval } = activeApproved
    ? await supabase.from("proposal_approvals").select("id").eq("tenant_id", tenant.id).eq("proposal_id", activeApproved.id).maybeSingle()
    : { data: null };

  const archived = Boolean(event.archived_at);
  const hasSignedContract = contracts.contracts.some((c) => c.status === "signed");
  const primary = event.event_clients.find((c) => c.is_primary) ?? null;
  const signer = event.event_clients.find((c) => c.can_sign) ?? null;
  const facts: WorkspaceFacts = {
    slug,
    eventId: event.id,
    now: new Date(),
    archived,
    lifecycle: event.lifecycle_status,
    proposals: event.proposals,
    activeProposalId: event.active_proposal_id,
    approvalId: approval?.id ?? null,
    contracts: contracts.contracts,
    payments: payments.summary,
    planning: {
      exists: Boolean(planning && planning.plan !== null),
      progress: planning && planning.plan !== null ? planning.progress : null,
      editing: planning && planning.plan !== null ? (planning.editing ?? null) : null,
    },
    primaryContact: primary?.clients ? { name: primary.clients.name, archived: Boolean(primary.clients.archived_at) } : null,
    identitySaved: Boolean(identity?.business_address && identity?.contact_email),
    usableContractVersions: contracts.options.length,
  };
  const action = nextAction(facts);
  const pay = paymentOverview(payments.summary);
  const { draft, active } = currentProposals({ proposals: event.proposals, activeProposalId: event.active_proposal_id });
  const olderProposals = [...event.proposals].filter((p) => p.id !== draft?.id && p.id !== active?.id).sort((a, b) => b.revision - a.revision);
  const onEvent = new Set(event.event_clients.map((c) => c.clients?.id));
  const status = eventStatusLabel(event.lifecycle_status, hasSignedContract);

  return (
    <>
      <header className="grid gap-2">
        <Link className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground" href={`/staff/${slug}/events`}>
          <ArrowLeft aria-hidden className="size-3.5" /> Back to events
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-1">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{event.title}</h1>
            <p className="text-sm text-muted-foreground" data-testid="event-meta">
              {shortDate(event.event_date)} · {event.venue_name ?? "Venue not set"} · {TYPE_LABEL[event.event_type] ?? event.event_type}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {archived ? <Badge variant="secondary">Archived</Badge> : null}
            <Badge variant="outline" className={cn("h-auto whitespace-normal", event.lifecycle_status === "booked" ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null)}>
              {status}
            </Badge>
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href="#edit-details">Edit details</a>
          </div>
        </div>
      </header>

      {contact === "failed" ? <p role="alert" className="text-sm text-destructive">The event was created but its contact could not be attached. Add the contact below.</p> : null}

      <NextStep action={action} archived={archived} />

      <section aria-label="Overview" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile title="Proposal" summary={proposalSummary(facts)} testId="overview-proposal" />
        <Tile title="Contract" summary={contractSummary(facts, fmt)} testId="overview-contract" />
        <div className="grid content-start gap-1.5 rounded-xl border bg-card p-3.5 text-sm" data-testid="overview-payments">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Payments</h2>
            <a className="text-xs font-medium underline-offset-4 hover:underline" href="#payments">Details</a>
          </div>
          {pay ? (
            <>
              <p className="font-medium">{pay.booking}</p>
              <dl className="grid gap-0.5">
                {pay.rows.map((r) => (
                  <div key={r.label} className="flex flex-wrap justify-between gap-x-3">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="text-right tabular-nums">{r.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">{pay.basis}</p>
              {pay.warning ? (
                <p className="flex gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                  <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" /> {pay.warning}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">Unavailable</p>
          )}
        </div>
        <Tile title="Planning" summary={planningSummary(facts)} testId="overview-planning" extra={planningLine(facts.planning)} />
      </section>

      <nav aria-label="Event sections" className="flex flex-wrap gap-x-4 gap-y-1 border-b pb-2 text-sm">
        {[
          ["#proposal", "Proposal & contract"],
          ["#payments", "Payments"],
          ["#planning", "Planning"],
          ["#contacts", "Contacts & details"],
        ].map(([href, label]) => (
          <a key={href} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={href}>{label}</a>
        ))}
      </nav>

      <div className="grid gap-6">
        <Card id="proposal" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Proposal</CardTitle>
            <CardDescription>One editable draft per event. The client sees an offer only once it&apos;s sent.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {hasSignedContract ? (
              <p role="status">A contract has been signed for this event, so its terms can&apos;t be revised. Amendments aren&apos;t available yet.</p>
            ) : null}
            {draft || active ? (
              <ul className="grid gap-1.5">
                {[draft, active].filter((p, i, all) => p && all.indexOf(p) === i).map((p) => (
                  <li key={p!.id} className="flex flex-wrap items-baseline gap-x-2">
                    <Link className="font-medium underline" href={`/staff/${slug}/proposals/${p!.id}`}>
                      {p === draft ? `Continue the draft (revision ${p!.revision})` : `Revision ${p!.revision}`}
                    </Link>
                    {p !== draft ? <span className="text-muted-foreground">{PROPOSAL_STATUS[p!.status] ?? p!.status}{p!.offer_frozen_at ? " · offer frozen" : ""}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {archived && !draft && !hasSignedContract ? <p className="text-muted-foreground">Unarchive the event to start or revise an offer.</p> : null}
            {draft || hasSignedContract || archived ? null : (
              <ActionForm action={openProposalDraft.bind(null, slug, event.id)} submitLabel={event.active_proposal_id ? "Start a revised offer" : "Start proposal draft"} pendingLabel="Opening…">
                <SelectField
                  label="Start from template"
                  name="template_id"
                  options={(templates ?? []).map((t) => ({ value: t.id, label: t.name }))}
                  placeholder={event.active_proposal_id ? "— the current offer —" : "— blank proposal —"}
                />
              </ActionForm>
            )}
            {olderProposals.length > 0 ? (
              <Disclosure id="proposal-history" summary={`Proposal history (${olderProposals.length})`}>
                <ul className="grid gap-1">
                  {olderProposals.map((p) => (
                    <li key={p.id}>
                      <Link className="underline" href={`/staff/${slug}/proposals/${p.id}`}>Revision {p.revision}</Link>
                      <span className="text-muted-foreground"> · {PROPOSAL_STATUS[p.status] ?? p.status}{p.offer_frozen_at ? " · offer frozen" : ""}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </CardContent>
        </Card>

        <ContractCard slug={slug} approvalId={approval?.id ?? null} data={contracts} />

        <PaymentsCard staff={staff} slug={slug} eventId={event.id} archived={archived} data={payments} recordOpen={action.key === "record_payment"} />

        <PlanningCard slug={slug} eventId={event.id} view={planning} archived={archived} />

        <div className="grid gap-6 lg:grid-cols-2">
          <Card id="contacts" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
              <CardDescription>The primary contact receives proposals; the signer signs the contract.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <ul className="grid gap-2">
                {event.event_clients.map((ec) => (
                  <li key={ec.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0">
                    <span className="grid min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{ec.clients?.name}</span>
                        {ec.is_primary ? <Badge>Primary</Badge> : null}
                        {ec.can_sign ? <Badge variant="secondary">Signer</Badge> : null}
                        {ec.clients?.archived_at ? <Badge variant="outline">Archived client</Badge> : null}
                      </span>
                      <span className="break-all text-muted-foreground">{ec.clients?.email}</span>
                    </span>
                    <RemoveContact action={removeEventContact.bind(null, slug, event.id, ec.id)} />
                  </li>
                ))}
                {event.event_clients.length === 0 ? <li className="text-muted-foreground">No contacts yet.</li> : null}
              </ul>
              {signer && primary && signer.id !== primary.id ? <p className="text-xs text-muted-foreground">The signer is not the primary contact.</p> : null}
              <Disclosure id="add-contact" summary="Add a contact">
                <ActionForm action={addEventContact.bind(null, slug, event.id)} submitLabel="Add contact" resetOnSuccess trackUnsaved>
                  <SelectField label="Client" name="client_id" options={(clients ?? []).filter((c) => !onEvent.has(c.id)).map((c) => ({ value: c.id, label: `${c.name} (${c.email})` }))} placeholder="— choose —" />
                  <CheckboxField
                    label="Make primary contact and signer"
                    name="is_primary"
                    hint={primary?.clients ? `Replaces ${primary.clients.name} as primary contact and signer.` : undefined}
                  />
                </ActionForm>
              </Disclosure>
            </CardContent>
          </Card>

          <Card id="details" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Event details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <dl className="grid gap-2" data-testid="event-details">
                <Detail label="Date">{shortDate(event.event_date)}</Detail>
                <Detail label="Time zone">{event.timezone}</Detail>
                <Detail label="Type">{TYPE_LABEL[event.event_type] ?? event.event_type}</Detail>
                <Detail label="Venue">{event.venue_name ?? <span className="text-muted-foreground">Not set</span>}</Detail>
                <Detail label="Address">{event.venue_address ?? <span className="text-muted-foreground">Not set</span>}</Detail>
                <Detail label="Internal notes · staff only">
                  {event.internal_notes ? <span className="whitespace-pre-line">{event.internal_notes}</span> : <span className="text-muted-foreground">None</span>}
                </Detail>
              </dl>
              <Disclosure id="edit-details" summary="Edit details">
                <ActionForm action={updateEvent.bind(null, slug, event.id)} submitLabel="Save event" trackUnsaved>
                  <EventFields event={event} defaultTimezone={tenant.timezone} />
                </ActionForm>
              </Disclosure>
            </CardContent>
          </Card>
        </div>

        <Card id="manage" size="sm" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>{archived ? "Archived" : "Manage event"}</CardTitle>
            <CardDescription>Archiving is separate from cancelling or booking. Nothing is deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <ArchivePanel slug={slug} eventId={event.id} archived={archived} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function NextStep({ action, archived }: { action: NextAction; archived: boolean }) {
  return (
    <section
      aria-labelledby="next-step-heading"
      data-testid="next-action"
      data-key={action.key}
      className={cn("grid gap-3 rounded-xl border p-4 sm:p-5", archived ? "bg-muted/40" : action.waiting ? "bg-card" : "border-foreground/20 bg-card shadow-xs")}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {action.waiting ? <Clock aria-hidden className="size-3.5" /> : null}
        {archived ? "Archived" : action.waiting ? "Waiting on the client" : "Next step"}
      </p>
      <div className="grid gap-1">
        <h2 id="next-step-heading" className="text-lg font-semibold">{action.title}</h2>
        {archived ? (
          <p role="status" className="text-sm">
            This event is archived. It is hidden from the events list, its client links are revoked, and proposals can&apos;t be sent or
            approved and contracts can&apos;t be generated until you unarchive it. Its history is kept.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{action.detail}</p>
        )}
      </div>
      {action.blockers.length > 0 ? (
        <ul className="grid gap-1.5 text-sm" aria-label="Before you can continue">
          {action.blockers.map((b) => (
            <li key={b.text} className="flex flex-wrap items-baseline gap-x-2">
              <AlertTriangle aria-hidden className="size-3.5 shrink-0 self-center text-amber-700 dark:text-amber-400" />
              <span>{b.text}</span>
              <ActionLink className="font-medium underline" href={b.link.href}>{b.link.label}</ActionLink>
            </li>
          ))}
        </ul>
      ) : null}
      {action.warning ? (
        <p role="status" className="flex gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <span>
            {action.warning} <a className="font-medium underline" href="#payments">Payments</a>
          </span>
        </p>
      ) : null}
      {action.primary || action.secondary ? (
        <div className="flex flex-wrap gap-2">
          {action.primary ? (
            <ActionLink className={buttonVariants()} href={action.primary.href} testId="next-action-primary">
              {action.primary.label} <ArrowRight aria-hidden />
            </ActionLink>
          ) : null}
          {action.secondary ? (
            <ActionLink className={buttonVariants({ variant: "outline" })} href={action.secondary.href} testId="next-action-secondary">
              {action.secondary.label}
            </ActionLink>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** In-page anchors are plain links (the browser scrolls and fires hashchange); other pages use the router. */
function ActionLink({ href, className, testId, children }: { href: string; className?: string; testId?: string; children: React.ReactNode }) {
  return href.startsWith("#") ? (
    <a className={className} href={href} data-testid={testId}>{children}</a>
  ) : (
    <Link className={className} href={href} data-testid={testId}>{children}</Link>
  );
}

function Tile({ title, summary, testId, extra }: { title: string; summary: Summary; testId: string; extra?: string | null }) {
  const internal = summary.link.href.startsWith("#");
  const link = internal ? (
    <a className="text-xs font-medium underline-offset-4 hover:underline" href={summary.link.href}>{summary.link.label}</a>
  ) : (
    <Link className="text-xs font-medium underline-offset-4 hover:underline" href={summary.link.href}>{summary.link.label}</Link>
  );
  return (
    <div className={cn("grid content-start gap-1.5 rounded-xl border bg-card p-3.5 text-sm", summary.attention ? "border-foreground/30" : null)} data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h2>
        {link}
      </div>
      <p className="font-medium">{summary.status}</p>
      {summary.detail ? <p className="text-muted-foreground">{summary.detail}</p> : null}
      {extra ? <p className="text-xs text-muted-foreground">{extra}</p> : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
