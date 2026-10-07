import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, FilterSelect, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { shortDate } from "@/lib/dates";
import { eventStatusLabel } from "@/lib/events/status";
import { EVENT_STATUSES, EVENT_VIEWS, PAGE_SIZE, eventListHref, eventListSchema, isDefaultEventList, nearDay, parseEventListParams, rangeText } from "@/lib/lists";
import { cn } from "@/lib/utils";

const ORDER_NOTE = { upcoming: "nearest first", past: "most recent first", all: "latest date first" } as const;
const VIEW_NOUN = { upcoming: "upcoming", past: "past", all: "" } as const;

/** The business's events as a list: search, date view, status and archived filters, all in the URL. Read-only. */
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
  });
  const parsed = eventListSchema.safeParse(data);
  if (error || !parsed.success) throw new Error("The events list couldn't be loaded.");
  const list = parsed.data;
  const noun = (n: number) => `${n} ${VIEW_NOUN[p.view] ? `${VIEW_NOUN[p.view]} ` : ""}event${n === 1 ? "" : "s"}`;

  return (
    <>
      <PageHeader title="Events" actions={<Link className={buttonVariants()} href={`${base}/new`}>New event</Link>} />
      <ListFilters label="Filter events" query={p.q} placeholder="Event, contact or venue" clearHref={base} showClear={!isDefaultEventList(p)} defaults={{ view: "upcoming" }}>
        <FilterSelect label="Dates" name="view" value={p.view} options={EVENT_VIEWS} />
        <FilterSelect label="Status" name="status" value={p.status ?? ""} options={[["", "All statuses"], ...EVENT_STATUSES]} />
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {list.total > 0 ? (
        <>
          <ResultLine>
            {noun(list.total)}, {ORDER_NOTE[p.view]}.
            {list.total > list.rows.length ? ` ${rangeText(p.page, list.rows.length, list.total)}.` : null}
            {list.archived_excluded > 0 ? (
              <>
                {" "}{list.archived_excluded} archived {list.archived_excluded === 1 ? "event also matches" : "events also match"}.{" "}
                <Link className="underline" href={eventListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Events" testId="event-list">
            {list.rows.map((e) => {
              const near = nearDay(e.event_date, e.today);
              return (
                <li key={e.id} data-testid="event-row">
                  <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)_auto] sm:items-center">
                    <span className="flex items-baseline gap-2 sm:grid sm:gap-0">
                      <span className="font-medium whitespace-nowrap">{shortDate(e.event_date)}</span>
                      {near ? <span className="text-xs text-muted-foreground">{near}</span> : null}
                    </span>
                    <span className="grid min-w-0">
                      <Link className="truncate font-medium underline-offset-4 hover:underline" href={`${base}/${e.id}`}>{e.title}</Link>
                      <span className="truncate text-muted-foreground">
                        {e.client_name ?? "No primary contact"} · <span className={e.venue_name ? undefined : "italic"}>{e.venue_name ?? "Venue not set"}</span>
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1 sm:justify-end">
                      {e.archived ? <Badge variant="secondary">Archived</Badge> : null}
                      <Badge variant="outline" className={cn("h-auto whitespace-normal", e.lifecycle_status === "booked" ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : null)}>
                        {eventStatusLabel(e.lifecycle_status, e.contract_signed)}
                      </Badge>
                    </span>
                  </div>
                </li>
              );
            })}
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
            {p.view === "upcoming" ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={eventListHref(base, { ...p, view: "past", page: 1 })}>Show past events</Link> : null}
            {!isDefaultEventList(p) ? <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={base}>Clear filters</Link> : null}
          </div>
        </EmptyList>
      )}
    </>
  );
}
