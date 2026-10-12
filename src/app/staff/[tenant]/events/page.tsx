import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EventRow } from "@/components/app/event-row";
import { EmptyList, FilterCheckbox, FilterDate, FilterSelect, ListRows, MoreFilters, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { shortDate } from "@/lib/dates";
import { eventDisplayStatus } from "@/lib/events/status";
import { EVENT_TYPES } from "@/lib/events/types";
import {
  EVENT_SORTS,
  EVENT_STATUSES,
  EVENT_VIEWS,
  PAGE_SIZE,
  eventListHref,
  eventListSchema,
  hasMoreEventFilters,
  isDefaultEventList,
  parseEventListParams,
  rangeText,
} from "@/lib/lists";

const ORDER_NOTE = { upcoming: "nearest first", past: "most recent first", all: "latest date first" } as const;
const SORT_NOTE = { updated: "most recently updated first", created: "newest first" } as const;
const TYPE_LABEL = Object.fromEntries(EVENT_TYPES) as Record<string, string>;
const VIEW_NOUN = { upcoming: "upcoming", past: "past", all: "" } as const;

/** The business's events as a list: search, date view, status, type, date range, order and archived filters, all in the URL. Read-only. */
export default async function Events({ params, searchParams }: PageProps<"/staff/[tenant]/events">) {
  const { tenant: slug } = await params;
  const p = parseEventListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/events`;
  const { data, error } = await supabase.rpc("staff_event_list", {
    p_tenant_id: tenant.id,
    p_view: p.view,
    p_status: p.status ?? undefined,
    p_query: p.q || undefined,
    p_include_archived: p.archived,
    p_limit: PAGE_SIZE,
    p_offset: (p.page - 1) * PAGE_SIZE,
    p_event_type: p.type ?? undefined,
    p_date_from: p.from ?? undefined,
    p_date_to: p.to ?? undefined,
    p_sort: p.sort,
  });
  const parsed = eventListSchema.safeParse(data);
  if (error || !parsed.success) throw new Error("The events list couldn't be loaded.");
  const list = parsed.data;
  const noun = (n: number) => `${n} ${VIEW_NOUN[p.view] ? `${VIEW_NOUN[p.view]} ` : ""}${p.type ? `${TYPE_LABEL[p.type].toLowerCase()} ` : ""}event${n === 1 ? "" : "s"}`;
  const range = p.from && p.to ? ` from ${shortDate(p.from)} to ${shortDate(p.to)}` : p.from ? ` from ${shortDate(p.from)}` : p.to ? ` until ${shortDate(p.to)}` : "";
  const order = p.sort === "date" ? ORDER_NOTE[p.view] : SORT_NOTE[p.sort];

  return (
    <>
      <PageHeader title="Events" actions={<Link className={buttonVariants()} href={`${base}/new`}>New event</Link>} />
      <ListFilters
        label="Filter events"
        query={p.q}
        placeholder="Event, client or venue"
        clearHref={base}
        showClear={!isDefaultEventList(p)}
        defaults={{ view: "upcoming", sort: "date" }}
        more={
          <MoreFilters open={hasMoreEventFilters(p)}>
            <FilterSelect label="Type" name="type" value={p.type ?? ""} options={[["", "All types"], ...EVENT_TYPES]} />
            <FilterDate label="From" name="from" value={p.from} />
            <FilterDate label="To" name="to" value={p.to} />
            <FilterSelect label="Order" name="sort" value={p.sort} options={EVENT_SORTS} />
            <p className="basis-full text-xs text-muted-foreground">Dates apply when you press Search. The range combines with the Dates view; choose All dates to search every date.</p>
          </MoreFilters>
        }
      >
        <FilterSelect label="Dates" name="view" value={p.view} options={EVENT_VIEWS} />
        <FilterSelect label="Status" name="status" value={p.status ?? ""} options={[["", "All statuses"], ...EVENT_STATUSES]} />
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {list.total > 0 ? (
        <>
          <ResultLine>
            {noun(list.total)}{range}, {order}.
            {list.total > list.rows.length ? ` ${rangeText(p.page, list.rows.length, list.total)}.` : null}
            {list.archived_excluded > 0 ? (
              <>
                {" "}{list.archived_excluded} archived {list.archived_excluded === 1 ? "event also matches" : "events also match"}.{" "}
                <Link className="underline" href={eventListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Events" testId="event-list">
            {list.rows.map((e) => (
              <EventRow
                key={e.id}
                href={`${base}/${e.id}`}
                title={e.title}
                eventDate={e.event_date}
                today={e.today}
                details={<>{e.client_name ?? "No primary contact"} · <span className={e.venue_name ? undefined : "italic"}>{e.venue_name ?? "Venue not set"}</span> · {TYPE_LABEL[e.event_type] ?? e.event_type}</>}
                status={e.lifecycle_status}
                contractSigned={e.contract_signed}
                statusLabel={eventDisplayStatus({ lifecycle: e.lifecycle_status, proposalStatus: e.proposal_status, proposalDraft: e.proposal_draft, contractStatus: e.contract_status })}
                archived={e.archived}
              />
            ))}
          </ListRows>
          <Pagination page={p.page} total={list.total} pageSize={PAGE_SIZE} href={(n) => eventListHref(base, { ...p, page: n })} />
        </>
      ) : list.tenant_events === 0 ? (
        <EmptyList testId="events-empty">
          <p>No events yet.</p>
          <Link className={buttonVariants({ size: "sm" })} href={`${base}/new`}>Create your first event</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="events-no-results">
          <p>
            {isDefaultEventList(p) ? "No upcoming events." : "No events match these filters."}
            {list.archived_excluded > 0 ? ` ${list.archived_excluded} archived ${list.archived_excluded === 1 ? "event matches" : "events match"} but ${list.archived_excluded === 1 ? "is" : "are"} hidden.` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {list.archived_excluded > 0 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={eventListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link> : null}
            {(p.from || p.to) && p.view !== "all" ? (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={eventListHref(base, { ...p, view: "all", page: 1 })}>Search all dates in this range</Link>
            ) : p.view === "upcoming" ? (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={eventListHref(base, { ...p, view: "past", page: 1 })}>Show past events</Link>
            ) : null}
            {!isDefaultEventList(p) ? <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={base}>Clear filters</Link> : null}
          </div>
        </EmptyList>
      )}
    </>
  );
}
