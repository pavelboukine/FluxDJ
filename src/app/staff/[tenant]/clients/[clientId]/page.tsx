import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Mail, Phone, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EventRow } from "@/components/app/event-row";
import { InlineEditor } from "@/components/app/inline-editor";
import { EmptyList, ListRows } from "@/components/app/list";
import { requireStaff } from "@/lib/auth/staff";
import { contractsUseClientPhone, emailChangeImpact, hasEmailImpact } from "@/lib/clients.server";
import { dateIn, shortDate } from "@/lib/dates";
import { eventDisplayStatus } from "@/lib/events/status";
import { UUID_RE } from "@/lib/forms";
import { contactRoleLabel, isUpcomingEvent, utcDateFrom } from "@/lib/lists";
import { telHref } from "@/lib/phone";
import { updateClientRecord } from "../actions";
import { ClientFields } from "../client-fields";
import { ClientArchivePanel } from "./client-archive-panel";

/** Upcoming events shown at most (a client rarely has more); history pages through the rest. */
const UPCOMING_LIMIT = 50;
const HISTORY_PAGE = 10;

const EVENT_COLUMNS =
  "id, title, event_date, timezone, venue_name, lifecycle_status, booking_source, archived_at, active_proposal_id, event_clients!inner(client_id, is_primary, can_sign), contracts(status), proposals!proposals_event_fk(id, status, expires_at)";

/**
 * One client: a readable overview with Edit details, their events (upcoming
 * first, then a paged history of past and archived events, split by each
 * event's own date) with their role on each, and archive management.
 */
export default async function ClientPage({ params, searchParams }: PageProps<"/staff/[tenant]/clients/[clientId]">) {
  const { tenant: slug, clientId } = await params;
  if (!UUID_RE.test(clientId)) notFound();
  const historyPage = pageNumber((await searchParams).history);
  const { supabase, tenant } = await requireStaff(slug);
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, email, phone, archived_at, created_at, updated_at")
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!client) notFound();

  const now = new Date();
  // Upcoming: not archived, today or later in each event's own time zone. The
  // query is bounded a day either side of UTC today and refined per row.
  const events = () =>
    supabase
      .from("events")
      .select(EVENT_COLUMNS)
      .eq("tenant_id", tenant.id)
      .eq("event_clients.client_id", client.id)
      .in("contracts.status", ["signed", "sent", "draft"]);
  const upcomingRes = await events().is("archived_at", null).gte("event_date", utcDateFrom(now, -1)).order("event_date").order("title").limit(UPCOMING_LIMIT);
  if (upcomingRes.error) throw new Error("This client's events couldn't be loaded.");
  const upcoming = shape(upcomingRes.data, now).filter((e) => e.upcoming);
  // History: archived or dated up to UTC tomorrow, minus the upcoming ones
  // near that boundary, so every page holds exactly the past and archived events.
  const boundary = upcoming.filter((e) => e.event_date <= utcDateFrom(now, 1)).map((e) => e.id);
  const historyFrom = (historyPage - 1) * HISTORY_PAGE;
  let historyQuery = events().or(`archived_at.not.is.null,event_date.lte.${utcDateFrom(now, 1)}`);
  if (boundary.length > 0) historyQuery = historyQuery.not("id", "in", `(${boundary.join(",")})`);
  const [historyRes, linkCount, contractsNeedPhone, impact] = await Promise.all([
    historyQuery
      .order("event_date", { ascending: false })
      .order("title")
      .order("id")
      .range(historyFrom, historyFrom + HISTORY_PAGE), // one extra row tells whether there are older events
    supabase.from("event_clients").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("client_id", client.id),
    contractsUseClientPhone(supabase, tenant.id),
    emailChangeImpact(supabase, tenant.id, client.id),
  ]);
  if (historyRes.error) throw new Error("This client's events couldn't be loaded.");
  const olderExists = historyRes.data.length > HISTORY_PAGE;
  const history = shape(historyRes.data.slice(0, HISTORY_PAGE), now).filter((e) => !e.upcoming);
  const totalEvents = linkCount.count ?? 0;
  const eventsBase = `/staff/${slug}/events`;
  const pageHref = (n: number) => `/staff/${slug}/clients/${client.id}${n > 1 ? `?history=${n}` : ""}#history`;
  const archived = Boolean(client.archived_at);

  return (
    <>
      <PageHeader
        title={client.name}
        description={
          <Link className="inline-flex items-center gap-1 underline-offset-4 hover:underline" href={`/staff/${slug}/clients`}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to clients
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {archived ? <Badge variant="secondary">Archived</Badge> : <Badge variant="outline">Active</Badge>}
            {archived ? null : (
              <Link className={buttonVariants({ size: "sm" })} href={`/staff/${slug}/events/new?client=${client.id}`} data-testid="new-event-for-client">
                <Plus aria-hidden /> New event
              </Link>
            )}
          </div>
        }
      />
      {archived ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This client is archived. They stay on their events and documents, but can&apos;t be chosen for new events or contacts, and proposals
          or contracts can&apos;t be sent to them until you restore them.
        </p>
      ) : null}

      <InlineEditor
        id="details"
        title="Contact details"
        editLabel="Edit details"
        view={<ClientOverview email={client.email} phone={client.phone} added={shortDate(dateIn(tenant.timezone, new Date(client.created_at)))} phoneNeeded={contractsNeedPhone} />}
        action={updateClientRecord.bind(null, slug, client.id)}
        submitLabel="Save details"
        discardMessage="Discard the changes you made to this client's details?"
      >
        <ClientFields client={client} contractsNeedPhone={contractsNeedPhone} />
        {hasEmailImpact(impact) ? (
          <p className="text-xs text-muted-foreground" data-testid="email-change-note">
            This email is already used for sign-ins or documents sent to this client. Changing it doesn&apos;t move that access to the new
            address; you&apos;ll be asked to confirm what stays with the old one.
          </p>
        ) : null}
      </InlineEditor>

      <section aria-labelledby="upcoming-heading" className="grid gap-3">
        <div className="grid gap-0.5">
          <h2 id="upcoming-heading" className="text-base font-semibold">Upcoming events</h2>
          <p className="text-sm text-muted-foreground">Nearest first. The role is this client&apos;s part on each event.</p>
        </div>
        {upcoming.length > 0 ? (
          <>
            <ListRows label="Upcoming events" testId="client-upcoming">
              {upcoming.map((e) => (
                <EventRow
                  key={e.id}
                  href={`${eventsBase}/${e.id}`}
                  title={e.title}
                  eventDate={e.event_date}
                  today={e.today}
                  details={<EventDetails role={e.role} venue={e.venue_name} />}
                  status={e.booking_source === "external" ? "external" : e.lifecycle_status}
                  contractSigned={e.signed}
                  statusLabel={e.statusLabel}
                  archived={e.archived}
                />
              ))}
            </ListRows>
            {upcomingRes.data.length >= UPCOMING_LIMIT ? (
              <p className="text-sm text-muted-foreground">Showing the next {UPCOMING_LIMIT} events.</p>
            ) : null}
          </>
        ) : (
          <EmptyList testId="client-upcoming-empty">
            <p>{totalEvents === 0 ? "No events yet. Create one for this client, or add them under an event's Contacts." : "No upcoming events."}</p>
            {archived ? null : (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`/staff/${slug}/events/new?client=${client.id}`}>
                New event for {client.name}
              </Link>
            )}
          </EmptyList>
        )}
      </section>

      {history.length > 0 || historyPage > 1 ? (
        <section id="history" aria-labelledby="history-heading" className="scroll-mt-20 grid gap-3">
          <div className="grid gap-0.5">
            <h2 id="history-heading" className="text-base font-semibold">Past and archived events</h2>
            <p className="text-sm text-muted-foreground">Most recent first.</p>
          </div>
          {history.length > 0 ? (
            <ListRows label="Past and archived events" testId="client-history">
              {history.map((e) => (
                <EventRow
                  key={e.id}
                  href={`${eventsBase}/${e.id}`}
                  title={e.title}
                  eventDate={e.event_date}
                  today={e.today}
                  details={<EventDetails role={e.role} venue={e.venue_name} />}
                  status={e.booking_source === "external" ? "external" : e.lifecycle_status}
                  contractSigned={e.signed}
                  statusLabel={e.statusLabel}
                  archived={e.archived}
                />
              ))}
            </ListRows>
          ) : (
            <EmptyList testId="client-history-empty">
              <p>No older events.</p>
            </EmptyList>
          )}
          {historyPage > 1 || olderExists ? (
            <nav aria-label="Event history pages" className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {historyPage > 1 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={pageHref(historyPage - 1)} rel="prev">Newer events</Link> : <span />}
              {olderExists ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={pageHref(historyPage + 1)} rel="next">Older events</Link> : <span />}
            </nav>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="manage-heading" className="grid gap-3 rounded-xl border p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="manage-heading" className="text-base font-semibold">{archived ? "Archived client" : "Manage client"}</h2>
          <p className="text-sm text-muted-foreground">
            Archiving hides a client from new work. It doesn&apos;t cancel their events or erase any history, and nothing is deleted.
          </p>
        </div>
        <ClientArchivePanel slug={slug} clientId={client.id} name={client.name} archived={archived} events={totalEvents} />
      </section>
    </>
  );
}

type EventRowData = {
  id: string;
  title: string;
  event_date: string;
  timezone: string;
  venue_name: string | null;
  lifecycle_status: string;
  booking_source: string;
  archived_at: string | null;
  active_proposal_id: string | null;
  event_clients: { is_primary: boolean; can_sign: boolean }[];
  contracts: { status: string }[];
  proposals: { id: string; status: string; expires_at: string | null }[];
};

/** Places each event by its own time zone's today and names this client's role on it. */
function shape(rows: EventRowData[], now: Date) {
  return rows.map((e) => {
    const today = dateIn(e.timezone, now);
    const archived = e.archived_at !== null;
    const statuses = new Set(e.contracts.map((c) => c.status));
    const contractStatus = statuses.has("signed") ? "signed" : statuses.has("sent") ? "sent" : statuses.has("draft") ? "draft" : null;
    const active = e.proposals.find((p) => p.id === e.active_proposal_id);
    const proposalStatus = active ? (active.status === "sent" && active.expires_at && new Date(active.expires_at) <= now ? "expired" : active.status) : null;
    return {
      ...e,
      today,
      archived,
      upcoming: isUpcomingEvent({ event_date: e.event_date, archived }, today),
      role: contactRoleLabel(e.event_clients[0] ?? { is_primary: false, can_sign: false }, e.booking_source === "external"),
      signed: contractStatus === "signed",
      statusLabel: eventDisplayStatus({ lifecycle: e.lifecycle_status, bookingSource: e.booking_source, proposalStatus, proposalDraft: e.proposals.some((p) => p.status === "draft"), contractStatus }),
    };
  });
}

function pageNumber(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}

function EventDetails({ role, venue }: { role: string; venue: string | null }) {
  return (
    <>
      <span className="text-foreground/80" data-testid="client-role">{role}</span> · <span className={venue ? undefined : "italic"}>{venue ?? "Venue not set"}</span>
    </>
  );
}

function ClientOverview({ email, phone, added, phoneNeeded }: { email: string; phone: string | null; added: string; phoneNeeded: boolean }) {
  const tel = telHref(phone);
  const link = "inline-flex min-w-0 items-center gap-1.5 break-all underline-offset-4 hover:underline";
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs font-medium text-muted-foreground">Email</dt>
        <dd>
          <a className={link} href={`mailto:${email}`}>
            <Mail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {email}
          </a>
        </dd>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs font-medium text-muted-foreground">Phone</dt>
        <dd>
          {phone && tel ? (
            <a className={link} href={tel}>
              <Phone aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {phone}
            </a>
          ) : phone ? (
            phone
          ) : (
            <span className="grid gap-0.5">
              <span className="text-muted-foreground italic">No phone number</span>
              {phoneNeeded ? (
                <span className="flex gap-1 text-xs text-amber-800 dark:text-amber-300" data-testid="phone-needed">
                  <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" /> Needed before generating a contract (your template includes it).
                </span>
              ) : null}
            </span>
          )}
        </dd>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <dt className="text-xs font-medium text-muted-foreground">Added</dt>
        <dd>{added}</dd>
      </div>
    </dl>
  );
}
