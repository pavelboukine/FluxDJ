import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, FilterSelect, ListRows, Pagination, ResultLine } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { contractsUseClientPhone } from "@/lib/clients.server";
import { CLIENT_SORTS, PAGE_SIZE, clientListHref, clientListSchema, isDefaultClientList, nextEventLabel, parseClientListParams, rangeText } from "@/lib/lists";
import { createClientRecord } from "./actions";
import { AddClientPanel } from "./add-client-panel";

const ORDER_NOTE = { name: "by name", recent: "newest first" } as const;

/** The business's clients: active by default, searchable by name, email or phone, sortable, all in the URL. Read-only. */
export default async function Clients({ params, searchParams }: PageProps<"/staff/[tenant]/clients">) {
  const { tenant: slug } = await params;
  const p = parseClientListParams(await searchParams);
  const { supabase, tenant } = await requireStaff(slug);
  const base = `/staff/${slug}/clients`;
  const [{ data, error }, contractsNeedPhone] = await Promise.all([
    supabase.rpc("staff_client_list", {
      p_tenant_id: tenant.id,
      p_query: p.q || undefined,
      p_include_archived: p.archived,
      p_limit: PAGE_SIZE,
      p_offset: (p.page - 1) * PAGE_SIZE,
      p_sort: p.sort,
    }),
    contractsUseClientPhone(supabase, tenant.id),
  ]);
  const parsed = clientListSchema.safeParse(data);
  if (error || !parsed.success) throw new Error("The clients list couldn't be loaded.");
  const list = parsed.data;

  return (
    <>
      <PageHeader
        title="Clients"
        description="Contacts for your events. They are private to your business."
        actions={<a className={buttonVariants()} href="#add-client">Add client</a>}
      />
      <AddClientPanel action={createClientRecord.bind(null, slug)} initiallyOpen={list.tenant_clients === 0} contractsNeedPhone={contractsNeedPhone} />

      <ListFilters label="Filter clients" query={p.q} placeholder="Name, email or phone" clearHref={base} showClear={!isDefaultClientList(p)} defaults={{ sort: "name" }}>
        <FilterSelect label="Sort" name="sort" value={p.sort} options={CLIENT_SORTS} />
        <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
      </ListFilters>

      {list.total > 0 ? (
        <>
          <ResultLine>
            {list.total} {p.archived ? "" : "active "}client{list.total === 1 ? "" : "s"}, {ORDER_NOTE[p.sort]}.
            {list.total > list.rows.length ? ` ${rangeText(p.page, list.rows.length, list.total)}.` : null}
            {list.archived_excluded > 0 ? (
              <>
                {" "}{list.archived_excluded} archived {list.archived_excluded === 1 ? "client also matches" : "clients also match"}.{" "}
                <Link className="underline" href={clientListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link>
              </>
            ) : null}
          </ResultLine>
          <ListRows label="Clients" testId="client-list">
            {list.rows.map((c) => (
              <li key={c.id} data-testid="client-row">
                <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-center">
                  <span className="grid min-w-0">
                    <Link className="truncate py-0.5 font-medium underline-offset-4 hover:underline" href={`${base}/${c.id}`}>{c.name}</Link>
                    <span className="truncate text-muted-foreground">{c.email}{c.phone ? ` · ${c.phone}` : ""}</span>
                  </span>
                  <span className="grid min-w-0 text-muted-foreground">
                    <span className="truncate" data-testid="event-count">{c.events === 0 ? "No events yet" : `${c.events} event${c.events === 1 ? "" : "s"}${c.next_event ? "" : ", none upcoming"}`}</span>
                    {c.next_event ? (
                      <span className="truncate">
                        <span className="text-foreground/80">{nextEventLabel(c.next_event).label}</span>{" "}
                        <Link className="underline-offset-4 hover:text-foreground hover:underline" href={`/staff/${slug}/events/${c.next_event.id}`} data-testid="next-event">
                          {nextEventLabel(c.next_event).date}
                        </Link>{" "}
                        · {c.next_event.title}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex sm:justify-end">{c.archived ? <Badge variant="secondary">Archived</Badge> : null}</span>
                </div>
              </li>
            ))}
          </ListRows>
          <Pagination page={p.page} total={list.total} pageSize={PAGE_SIZE} href={(n) => clientListHref(base, { ...p, page: n })} />
        </>
      ) : list.tenant_clients === 0 ? (
        <EmptyList testId="clients-empty">
          <p>No clients yet. Add one with the form above, or when you create an event.</p>
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`/staff/${slug}/events/new`}>Create an event</Link>
        </EmptyList>
      ) : (
        <EmptyList testId="clients-no-results">
          <p>
            {p.q ? "No clients match this search." : "No active clients."}
            {list.archived_excluded > 0 ? ` ${list.archived_excluded} archived ${list.archived_excluded === 1 ? "client matches" : "clients match"} but ${list.archived_excluded === 1 ? "is" : "are"} hidden.` : null}
          </p>
          {p.q ? <p>Search covers names, emails and phone numbers. Not on file yet? Add them as a new client.</p> : null}
          <div className="flex flex-wrap gap-2">
            {list.archived_excluded > 0 ? <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={clientListHref(base, { ...p, archived: true, page: 1 })}>Include archived</Link> : null}
            {p.q ? <a className={buttonVariants({ variant: "outline", size: "sm" })} href="#add-client">Add client</a> : null}
            {!isDefaultClientList(p) ? <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={base}>Clear filters</Link> : null}
          </div>
        </EmptyList>
      )}
    </>
  );
}
