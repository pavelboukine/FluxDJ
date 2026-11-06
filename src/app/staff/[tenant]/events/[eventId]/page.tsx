import Link from "@/components/app/pending-link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, ArrowRight, Clock, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { ClientPicker } from "@/components/app/client-picker";
import { CheckboxField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { dateIn, shortDate } from "@/lib/dates";
import { BOOKED_EXTERNALLY_DETAIL, eventDisplayStatus } from "@/lib/events/status";
import { contractChanges, currentProposals, nextAction, workspaceStage, type NextAction, type WorkspaceFacts } from "@/lib/events/workspace";
import { UUID_RE } from "@/lib/forms";
import { planAwaitingSetup } from "@/lib/planning/view";
import { telHref } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { searchClients } from "../../clients/actions";
import { ContractCard, loadContracts } from "../../contracts/contract-card";
import { addEventContact, removeEventContact, setEventContractFirst, updateEvent } from "../actions";
import { EventFields } from "../event-fields";
import { EVENT_TYPES } from "../event-form";
import { ArchivePanel } from "./archive-panel";
import { ClientAccess, loadPlanningAccess } from "./client-access-card";
import { EventEmails, emailProblems, loadCommunications } from "./communications-card";
import { DocumentsSection, ProposalCard } from "./documents-section";
import { PaymentsCard, loadPayments } from "./payments-card";
import { PlanningCard, loadPlanning } from "./planning-card";
import { RemoveContact } from "./remove-contact";

const TYPE_LABEL = Object.fromEntries(EVENT_TYPES) as Record<string, string>;

/**
 * The staff event workspace: what the event is, the recommended next step,
 * then the sections where each part is handled, ordered by the event's stage
 * (workspaceStage): the proposal and contract while booking, payments and
 * planning once signed or booked, with documents, emails, contacts and
 * details as supporting sections. Each section shows its own status. Rendering only reads: it never sets up a
 * plan, books, or changes anything. Every action stays on its existing
 * screen or form, with the database checking eligibility.
 */
export default async function EventPage({ params, searchParams }: PageProps<"/staff/[tenant]/events/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  const { contact } = await searchParams;
  if (!UUID_RE.test(eventId)) notFound();
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const [{ data: event }, { data: templates }, { data: identity }, contracts, payments, planning] = await Promise.all([
    supabase
      .from("events")
      .select("id, title, event_type, event_date, timezone, venue_name, venue_address, internal_notes, dj_name, lifecycle_status, booking_source, contract_first, booking_confirmed_at, active_proposal_id, archived_at, event_clients(id, is_primary, can_sign, clients(id, name, email, phone, archived_at)), proposals!proposals_event_fk(id, revision, status, offer_frozen_at, updated_at, expires_at)")
      .eq("id", eventId)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    supabase.from("proposal_templates").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name"),
    supabase.from("tenants").select("business_address, contact_email").eq("id", tenant.id).single(),
    loadContracts(staff, eventId),
    loadPayments(staff, eventId),
    loadPlanning(staff, eventId),
  ]);
  if (!event) notFound();
  // Booked elsewhere: planning is the whole workflow; client access comes from a planning invitation.
  const external = event.booking_source === "external";
  const contractFirst = event.contract_first;
  // Booked for planning, as the database decides it (private.event_booked_for_planning).
  const bookedForPlanning = external || (Boolean(event.booking_confirmed_at) && (event.lifecycle_status === "booked" || event.lifecycle_status === "completed"));
  const primaryClient = event.event_clients.find((c) => c.is_primary)?.clients ?? null;
  const planningAccess = await loadPlanningAccess(staff, eventId, primaryClient ? { id: primaryClient.id, email: primaryClient.email } : null);
  const communications = await loadCommunications(
    staff,
    event.proposals.map((p) => p.id),
    contracts.contracts.map((c) => c.id),
    planningAccess.invitationIds,
  );
  // Client access is shown once there is planning to invite to (or an invitation's history to show).
  const showClientAccess = external || bookedForPlanning || planningAccess.invitationIds.length > 0;
  const latestInvitation = planningAccess.access.invitation;
  const invitationEmail = latestInvitation
    ? (communications.rows.find((r) => r.entity_type === "planning_invitation" && r.entity_id === latestInvitation.id && r.event_type === "planning_invitation") ?? null)
    : null;
  // The current approval, if the active proposal is approved; contracts are generated from it.
  const activeApproved = event.proposals.find((p) => p.id === event.active_proposal_id && p.status === "approved");
  const { data: approval } = activeApproved
    ? await supabase.from("proposal_approvals").select("id").eq("tenant_id", tenant.id).eq("proposal_id", activeApproved.id).maybeSingle()
    : { data: null };

  const archived = Boolean(event.archived_at);
  const hasSignedContract = contracts.contracts.some((c) => c.status === "signed");
  const primary = event.event_clients.find((c) => c.is_primary) ?? null;
  const signer = event.event_clients.find((c) => c.can_sign) ?? null;
  // The template version generation would use by default prints the client's phone, and the signer has none.
  const defaultVersion = contracts.options.find((o) => o.id === contracts.defaultVersionId) ?? contracts.options[0] ?? null;
  const signerClient = signer?.clients && !signer.clients.archived_at ? signer.clients : null;
  const signerPhoneMissing = signerClient && !signerClient.phone && defaultVersion?.needsClientPhone ? { clientId: signerClient.id, name: signerClient.name } : null;
  const anyVersionNeedsPhone = contracts.options.some((o) => o.needsClientPhone);
  const currentContract = contracts.contracts.find((c) => c.status === "sent") ?? contracts.contracts.find((c) => c.status === "draft") ?? null;
  const changes = currentContract
    ? contractChanges(currentContract.frozen, { title: event.title, date: event.event_date, venueName: event.venue_name, venueAddress: event.venue_address, signerPhone: signer?.clients?.phone ?? null })
    : [];
  const facts: WorkspaceFacts = {
    slug,
    eventId: event.id,
    now: new Date(),
    archived,
    lifecycle: event.lifecycle_status,
    bookingSource: event.booking_source,
    contractFirst,
    planningAccess: planningAccess.access,
    proposals: event.proposals,
    activeProposalId: event.active_proposal_id,
    approvalId: approval?.id ?? null,
    contracts: contracts.contracts,
    payments: payments.summary,
    planning: {
      exists: Boolean(planning && planning.plan !== null),
      awaitingSetup: planning ? planAwaitingSetup(planning) : false,
      progress: planning && planning.plan !== null ? planning.progress : null,
      editing: planning && planning.plan !== null ? (planning.editing ?? null) : null,
    },
    primaryContact: primary?.clients ? { name: primary.clients.name, archived: Boolean(primary.clients.archived_at) } : null,
    identitySaved: Boolean(identity?.business_address && identity?.contact_email),
    usableContractVersions: contracts.options.length,
    signerPhoneMissing,
    contractChanges: changes,
    emailProblems: emailProblems(communications.rows),
    businessTimeZone: tenant.timezone,
  };
  const action = nextAction(facts);
  const layout = workspaceStage(facts);
  const { draft, active } = currentProposals({ proposals: event.proposals, activeProposalId: event.active_proposal_id });
  const olderProposals = [...event.proposals].filter((p) => p.id !== draft?.id && p.id !== active?.id).sort((a, b) => b.revision - a.revision);
  const onEvent = event.event_clients.flatMap((c) => (c.clients ? [c.clients.id] : []));
  const contractStatuses = new Set(contracts.contracts.map((c) => c.status));
  const status = eventDisplayStatus({
    lifecycle: event.lifecycle_status,
    bookingSource: event.booking_source,
    proposalStatus: active ? (active.status === "sent" && active.expires_at && new Date(active.expires_at) <= facts.now ? "expired" : active.status) : null,
    proposalDraft: Boolean(draft),
    contractStatus: contractStatuses.has("signed") ? "signed" : contractStatuses.has("sent") ? "sent" : contractStatuses.has("draft") ? "draft" : null,
  });
  const when = archived ? null : daysAway(event.event_date, dateIn(event.timezone, facts.now));
  // The proposal step can still be turned on or off: nothing has been started that could depend on it.
  const canChangeSteps = !external && !archived && event.lifecycle_status === "lead" && event.proposals.length === 0 && contracts.contracts.length === 0;
  const frozenDocs = Boolean(active) || contracts.contracts.some((c) => ["draft", "sent", "signed"].includes(c.status));
  const fmtDate = (iso: string) => shortDate(dateIn(event.timezone, new Date(iso)));
  // Once a contract is signed and the event is waiting for its deposit or booked, the proposal and contract are
  // reference documents (a signed contract leaves nothing to generate or revise): a compact Documents section.
  const documentsSecondary = (layout.stage === "deposit" || layout.stage === "booked") && hasSignedContract;
  // After booking (or for an event booked elsewhere), contacts and details are reference: one line each until opened.
  const compact = layout.stage !== "booking";
  // What a collapsed Contacts section still says (and opens for): the problems its contents would show.
  const signerPhoneNeeded = Boolean(!external && signerClient && !signerClient.phone && anyVersionNeedsPhone && !hasSignedContract);
  const contactsAttention = !primary?.clients ? "No primary contact" : primary.clients.archived_at ? "Primary contact archived" : signerPhoneNeeded ? "Signer phone needed" : null;
  const emailAttention = facts.emailProblems?.length ?? 0;
  const clientAccess = showClientAccess ? (
    <ClientAccess
      slug={slug}
      eventId={event.id}
      access={planningAccess.access}
      email={invitationEmail}
      booked={bookedForPlanning}
      planningReady={facts.planning.exists && !facts.planning.awaitingSetup}
      editingOpen={Boolean(facts.planning.editing && facts.planning.editing.state !== "closed")}
      primary={primary?.clients ? { id: primary.clients.id, name: primary.clients.name, email: primary.clients.email, archived: Boolean(primary.clients.archived_at) } : null}
      archived={archived}
      external={external}
      fmt={fmtDate}
    />
  ) : null;
  const planningSection = (
    <PlanningCard slug={slug} eventId={event.id} view={planning} archived={archived} external={external} businessTimeZone={tenant.timezone} access={clientAccess} />
  );
  // Flux DJ records no payments for an event booked elsewhere (the database refuses them).
  const paymentsSection = external ? null : (
    <PaymentsCard staff={staff} slug={slug} eventId={event.id} archived={archived} data={payments} recordOpen={action.key === "record_payment"} timeZone={event.timezone} />
  );

  return (
    <>
      <header className="grid gap-2">
        <Link className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground active:opacity-70" href={`/staff/${slug}/events`}>
          <ArrowLeft aria-hidden className="size-3.5" /> Back to events
        </Link>
        {/*
          One wrapping row, so nothing is duplicated: the title, then the status badge beside it (on its own line
          when the title is long). On phones the date and venue follow, then Edit details as a quiet text action;
          from sm, the title takes the free width and the badge and an outlined Edit details sit at the right, with
          the date and venue on the line below.
        */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:gap-x-3">
          <h1 className="order-1 min-w-0 max-w-full text-2xl font-semibold tracking-tight break-words sm:flex-1">{event.title}</h1>
          <div className="order-2 flex flex-wrap items-center gap-2">
            {archived ? <Badge variant="secondary">Archived</Badge> : null}
            <Badge
              variant="outline"
              data-testid="event-header-status"
              title={external ? BOOKED_EXTERNALLY_DETAIL : undefined}
              className={cn(
                "h-auto whitespace-normal",
                event.lifecycle_status === "booked" ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null,
                external ? "border-sky-600/40 bg-sky-600/10 text-sky-900 dark:text-sky-200" : null,
              )}
            >
              {status}
            </Badge>
          </div>
          <a
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "order-4 sm:order-3 sm:h-7",
              // Phones: a quiet text action with a 44px tap area, not a bordered button.
              "max-sm:-ml-1 max-sm:h-11 max-sm:border-transparent max-sm:bg-transparent max-sm:px-1 max-sm:text-muted-foreground max-sm:hover:bg-transparent max-sm:hover:text-foreground max-sm:dark:border-transparent max-sm:dark:bg-transparent",
            )}
            href="#edit-details"
            data-testid="edit-details-link"
          >
            <Pencil aria-hidden className="sm:hidden" />
            Edit details
          </a>
          <div className="order-3 grid basis-full gap-1 sm:order-4">
            <p className="text-sm text-muted-foreground" data-testid="event-meta">
              {shortDate(event.event_date)} · {event.venue_name ?? "Venue not set"} · {TYPE_LABEL[event.event_type] ?? event.event_type}
            </p>
            {when ? <p className={cn("text-sm font-medium", when.soon ? "text-amber-800 dark:text-amber-300" : "text-foreground/80")} data-testid="event-when">{when.label}</p> : null}
            {external ? <p className="text-sm text-muted-foreground" data-testid="booking-source-note">{BOOKED_EXTERNALLY_DETAIL}</p> : null}
            {contractFirst ? <p className="text-sm text-muted-foreground" data-testid="booking-source-note">No proposal: this event goes straight to a contract.</p> : null}
          </div>
        </div>
      </header>

      {contact === "failed" ? <p role="alert" className="text-sm text-destructive">The event was created but its contact could not be attached. Add the contact under Contacts.</p> : null}

      {/*
        One DOM order at every width: the work for the event's stage, then the supporting sections. Below xl they
        stack in that order; from xl the supporting sections sit in a second column (not sticky). On phones, the
        forms' buttons, fields and selects are touch-sized here (the shared components keep their size elsewhere).
      */}
      <div
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem] max-sm:[&_[data-slot=button]]:min-h-11 max-sm:[&_[data-slot=input]]:min-h-11 max-sm:[&_select]:min-h-11"
        data-testid="workspace"
        data-stage={layout.stage}
      >
        <div className="grid min-w-0 gap-6" data-testid="workspace-main">
          <NextStep action={action} archived={archived} external={external} contractFirst={contractFirst} />
          {external ? (
            planningSection
          ) : documentsSecondary ? (
            <>
              {paymentsSection}
              {planningSection}
            </>
          ) : (
            <>
              {canChangeSteps ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground" data-testid="booking-steps-switch">
                  <span>{contractFirst ? "Need the client to choose a package first?" : "Not using a proposal for this event?"}</span>
                  <ActionForm action={setEventContractFirst.bind(null, slug, event.id, !contractFirst)} submitLabel={contractFirst ? "Add a proposal" : "Skip the proposal"} variant="outline">{null}</ActionForm>
                </div>
              ) : null}
              {contractFirst ? null : <ProposalCard
                slug={slug}
                eventId={event.id}
                draft={draft}
                active={active}
                older={olderProposals}
                hasSignedContract={hasSignedContract}
                archived={archived}
                revising={Boolean(event.active_proposal_id)}
                templates={templates ?? []}
              />}
              <ContractCard
                slug={slug}
                approvalId={approval?.id ?? null}
                contractFirstEventId={contractFirst ? event.id : null}
                data={contracts}
                signer={signerClient ? { clientId: signerClient.id, name: signerClient.name, phone: signerClient.phone } : null}
                changes={changes}
              />
              {paymentsSection}
              {planningSection}
            </>
          )}
        </div>

        <aside aria-label="Event information" className="grid min-w-0 gap-3" data-testid="workspace-secondary">
          {documentsSecondary ? <DocumentsSection slug={slug} draft={draft} active={active} older={olderProposals} contracts={contracts} /> : null}

          <Disclosure
            id="communications"
            summary="Emails"
            defaultOpen={emailAttention > 0}
            hint={
              emailAttention > 0 ? (
                <Attention>{emailAttention === 1 ? "1 needs attention" : `${emailAttention} need attention`}</Attention>
              ) : communications.total === 0 ? (
                "None yet"
              ) : (
                `${communications.total} email${communications.total === 1 ? "" : "s"}`
              )
            }
          >
            <EventEmails slug={slug} data={communications} timeZone={event.timezone} />
          </Disclosure>

          <Disclosure
            id="contacts"
            summary="Contacts"
            targets={["add-contact"]}
            defaultOpen={!compact || contact === "failed" || Boolean(contactsAttention)}
            hint={contactsAttention ? <Attention>{contactsAttention}</Attention> : contactsLine(event.event_clients, external)}
          >
            <div className="grid gap-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {external ? "The primary contact is the one you invite to planning." : contractFirst ? "The signer signs the contract." : "The primary contact receives proposals; the signer signs the contract."}
              </p>
              <ul className="grid gap-2">
                {event.event_clients.map((ec) => (
                  <li key={ec.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0">
                    <span className="grid min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{ec.clients?.name}</span>
                        {ec.is_primary ? <Badge>Primary</Badge> : null}
                        {ec.can_sign && !external ? <Badge variant="secondary">Signer</Badge> : null}
                        {ec.clients?.archived_at ? <Badge variant="outline">Archived client</Badge> : null}
                      </span>
                      <span className="break-all text-muted-foreground">
                        {ec.clients?.email}
                        {ec.clients?.phone ? (
                          <>
                            {" · "}
                            {telHref(ec.clients.phone) ? <a className="underline-offset-4 hover:underline" href={telHref(ec.clients.phone)!}>{ec.clients.phone}</a> : ec.clients.phone}
                          </>
                        ) : null}
                      </span>
                      {ec.can_sign && ec.clients && !ec.clients.phone && anyVersionNeedsPhone && !hasSignedContract && !external ? (
                        <span className="flex gap-1 text-xs text-amber-800 dark:text-amber-300" data-testid="signer-phone-needed">
                          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
                          <span>
                            No phone number yet. Your contract template includes the client&apos;s phone, so it&apos;s needed before you generate the
                            contract. <Link className="font-medium underline" href={`/staff/${slug}/clients/${ec.clients.id}#details`}>Add phone</Link>
                          </span>
                        </span>
                      ) : null}
                      {ec.clients ? (
                        <Link className="w-fit text-xs underline-offset-4 hover:underline" href={`/staff/${slug}/clients/${ec.clients.id}`}>Client page</Link>
                      ) : null}
                    </span>
                    <RemoveContact action={removeEventContact.bind(null, slug, event.id, ec.id)} />
                  </li>
                ))}
                {event.event_clients.length === 0 ? <li className="text-muted-foreground">No contacts yet.</li> : null}
              </ul>
              {signer && primary && signer.id !== primary.id && !external ? <p className="text-xs text-muted-foreground">The signer is not the primary contact.</p> : null}
              <Disclosure id="add-contact" summary="Add a contact">
                <ActionForm action={addEventContact.bind(null, slug, event.id)} submitLabel="Add contact" resetOnSuccess>
                  <input type="hidden" name="expected_primary_client_id" value={primary?.clients?.id ?? ""} />
                  <ClientPicker search={searchClients.bind(null, slug)} name="client_id" label="Client" exclude={onEvent} />
                  <p className="text-xs text-muted-foreground">
                    Not a client yet? <Link className="underline" href={`/staff/${slug}/clients#add-client`}>Add them on the Clients page</Link> first.
                  </p>
                  <CheckboxField
                    label={external ? "Make primary contact" : "Make primary contact and signer"}
                    name="is_primary"
                    hint={primary?.clients ? `Replaces ${primary.clients.name} as primary contact${external ? "" : " and signer"}.` : undefined}
                  />
                </ActionForm>
              </Disclosure>
            </div>
          </Disclosure>

          {/* The title, date, venue, type and booking status are in the header; editing still covers every field. */}
          <Disclosure id="details" summary="Event details" targets={["edit-details"]} defaultOpen={!compact} hint={detailsLine(event)}>
            <div className="grid gap-3 text-sm">
              <dl className="grid gap-2" data-testid="event-details">
                <Detail label="Address">{event.venue_address ?? <span className="text-muted-foreground">Not set</span>}</Detail>
                <Detail label="Time zone">{event.timezone === tenant.timezone ? event.timezone : `${event.timezone} (not your business's ${tenant.timezone})`}</Detail>
                <Detail label="DJ">{event.dj_name ?? <span className="text-muted-foreground">Not set (planning uses the business&apos;s DJ name, or says “your DJ”)</span>}</Detail>
                <Detail label="Internal notes · staff only">
                  {event.internal_notes ? <span className="whitespace-pre-line">{event.internal_notes}</span> : <span className="text-muted-foreground">None</span>}
                </Detail>
              </dl>
              <Disclosure id="edit-details" summary="Edit details">
                {frozenDocs ? (
                  <p className="mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="edit-effect">
                    Saving changes the event record only. Sent proposals, the approved selection and contracts keep the details they were created
                    with{hasSignedContract ? ", and the signed contract never changes" : ""}. {hasSignedContract ? "" : "An unsent contract draft can be regenerated to use the new details."}
                  </p>
                ) : null}
                <ActionForm action={updateEvent.bind(null, slug, event.id)} submitLabel="Save event" trackUnsaved>
                  <EventFields event={event} defaultTimezone={tenant.timezone} />
                </ActionForm>
              </Disclosure>
            </div>
          </Disclosure>

          <Card id="manage" size="sm" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>{archived ? "Archived" : "Manage event"}</CardTitle>
              <CardDescription>{external ? "Archiving pauses client planning and cancels an open invitation. Nothing is deleted." : "Archiving is separate from cancelling or booking. Nothing is deleted."}</CardDescription>
            </CardHeader>
            <CardContent>
              <ArchivePanel slug={slug} eventId={event.id} archived={archived} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

/** "Noam Levi · primary & signer +1": who the event's contacts are, in one line. */
function contactsLine(rows: { is_primary: boolean; can_sign: boolean; clients: { name: string } | null }[], external: boolean): string {
  const primary = rows.find((r) => r.is_primary);
  if (!primary?.clients) return rows.length === 0 ? "None yet" : `${rows.length} contact${rows.length === 1 ? "" : "s"}`;
  const role = primary.can_sign && !external ? "primary & signer" : "primary";
  return `${primary.clients.name} · ${role}${rows.length > 1 ? ` +${rows.length - 1}` : ""}`;
}

/**
 * The collapsed Event details line: short, whatever was entered ("Address saved · Notes", "No address"). The
 * address and notes themselves are inside; the DJ's name, when set, is too.
 */
function detailsLine(e: { venue_address: string | null; internal_notes: string | null }): string {
  return [e.venue_address ? "Address saved" : "No address", e.internal_notes ? "Notes" : null].filter(Boolean).join(" · ");
}

/** A collapsed section's warning: amber with an icon, so it never depends on colour alone. */
function Attention({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300">
      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

/** "Today", "Tomorrow", "In 12 days" for an upcoming event (in its own time zone); null once it has passed or when far off. */
function daysAway(eventDate: string, today: string): { label: string; soon: boolean } | null {
  const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
  const diff = day(eventDate) - day(today);
  if (diff < 0 || diff > 60) return null;
  return { label: diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : `In ${diff} days`, soon: diff <= 14 };
}

/** The page's own actions: touch-sized on phones, the usual size from sm. */
const touch = "h-11 sm:h-8";

function NextStep({ action, archived, external, contractFirst }: { action: NextAction; archived: boolean; external: boolean; contractFirst: boolean }) {
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
        {archived && external ? (
          <p role="status" className="text-sm">
            This event is archived. It is hidden from the events list, the client can&apos;t open planning, an unaccepted planning invitation
            is cancelled, and planning can&apos;t be changed until you unarchive it. Its history is kept.
          </p>
        ) : archived ? (
          <p role="status" className="text-sm">
            This event is archived. It is hidden from the events list, its client links are revoked, and{" "}
            {contractFirst ? "" : "proposals can't be sent or approved and "}contracts can&apos;t be generated until you unarchive it. Its history is kept.
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
              <ActionLink className="font-medium underline active:opacity-70" href={b.link.href}>{b.link.label}</ActionLink>
            </li>
          ))}
        </ul>
      ) : null}
      {action.warning ? (
        <p role="status" className="flex gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <span>
            {action.warning.text} <a className="font-medium underline" href={action.warning.link.href}>{action.warning.link.label}</a>
          </span>
        </p>
      ) : null}
      {action.primary || action.secondary ? (
        <div className="flex flex-wrap gap-2">
          {action.primary ? (
            <ActionLink className={cn(buttonVariants(), touch)} href={action.primary.href} testId="next-action-primary">
              {action.primary.label} <ArrowRight aria-hidden />
            </ActionLink>
          ) : null}
          {action.secondary ? (
            <ActionLink className={cn(buttonVariants({ variant: "outline" }), touch)} href={action.secondary.href} testId="next-action-secondary">
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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
