import { Plus } from "lucide-react";
import Link from "@/components/app/pending-link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { EmptyList, FilterCheckbox, FilterSelect, INCLUDING_ARCHIVED, ListRow, ListRows, NoResults, Pagination, ResultLine, RowLink, activeLabels, optionLabel, outlineLink, rowRaised } from "@/components/app/list";
import { ListFilters } from "@/components/app/list-filters";
import { requireStaff } from "@/lib/auth/staff";
import { contractsUseClientPhone } from "@/lib/clients.server";
import { cn } from "@/lib/utils";
import { CLIENT_SORTS, PAGE_SIZE, clientListHref, clientListSchema, isDefaultClientList, nextEventLabel, parseClientListParams, rangeText } from "@/lib/lists";
import { createClientRecord } from "./actions";
import { AddClientPanel } from "./add-client-panel";

/** "Add client" links step aside while the add form is open, and come back when it closes. */
const hideWhileFormOpen = "[main:has(#add-client:not([hidden]))_&]:hidden";

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
  const none = list.tenant_clients === 0;

  return (
    <>
      <PageHeader
        title="Clients"
        description="Contacts for your events. They are private to your business."
        hideDescriptionOnPhone={!none}
        actions={
          <a className={cn(buttonVariants(), hideWhileFormOpen)} href="#add-client">
            <Plus aria-hidden className="max-md:hidden" />
            Add client
          </a>
        }
      />
      <AddClientPanel action={createClientRecord.bind(null, slug)} initiallyOpen={none} contractsNeedPhone={contractsNeedPhone} />

      {none ? null : (
        <ListFilters
          label="Filter clients"
          query={p.q}
          placeholder="Name, email or phone"
          clearHref={base}
          showClear={!isDefaultClientList(p)}
          defaults={{ sort: "name" }}
          active={activeLabels(p.sort !== "name" && `Sort: ${optionLabel(CLIENT_SORTS, p.sort)}`, p.archived && INCLUDING_ARCHIVED)}
        >
          <FilterSelect label="Sort" name="sort" value={p.sort} options={CLIENT_SORTS} />
          <FilterCheckbox label="Include archived" name="archived" checked={p.archived} />
        </ListFilters>
      )}

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
              <ListRow key={c.id} testId="client-row" className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-center">
                <span className="grid min-w-0">
                  <RowLink className="py-0.5 [overflow-wrap:anywhere] sm:truncate" href={`${base}/${c.id}`}>{c.name}</RowLink>
                  {/* From md, above the row's link so an address can be selected; on phones a tap anywhere opens the client. */}
                  <span className="grid w-fit max-w-full text-muted-foreground sm:block sm:truncate md:relative md:z-10 md:cursor-text" data-testid="client-contact">
                    <span className="[overflow-wrap:anywhere]">{c.email}</span>
                    {c.phone ? <span className="whitespace-nowrap"><span className="max-sm:hidden"> · </span>{c.phone}</span> : null}
                  </span>
                </span>
                <span className="grid min-w-0 text-muted-foreground">
                  <span className="truncate" data-testid="event-count">{c.events === 0 ? "No events yet" : `${c.events} event${c.events === 1 ? "" : "s"}${c.next_event ? "" : ", none upcoming"}`}</span>
                  {c.next_event ? (
                    <span className="[overflow-wrap:anywhere] sm:truncate">
                      <span className="text-foreground/80">{nextEventLabel(c.next_event).label}</span>{" "}
                      <Link className={cn(rowRaised, "tap-target-y underline underline-offset-4 hover:text-foreground")} href={`/staff/${slug}/events/${c.next_event.id}`} data-testid="next-event">
                        {nextEventLabel(c.next_event).date}
                      </Link>{" "}
                      · {c.next_event.title}
                    </span>
                  ) : null}
                </span>
                <span className="flex sm:justify-end">{c.archived ? <Badge variant="secondary">Archived</Badge> : null}</span>
              </ListRow>
            ))}
          </ListRows>
          <Pagination page={p.page} total={list.total} pageSize={PAGE_SIZE} href={(n) => clientListHref(base, { ...p, page: n })} />
        </>
      ) : none ? (
        <EmptyList
          testId="clients-empty"
          title="No clients yet."
          actions={<Link className={outlineLink} href={`/staff/${slug}/events/new`}>Create event</Link>}
        >
          Add your first client here, or when you create an event.
        </EmptyList>
      ) : (
        <NoResults
          testId="clients-no-results"
          title={p.q ? "No clients match this search." : "No active clients."}
          noun={["client", "clients"]}
          archived={list.archived_excluded}
          includeArchivedHref={clientListHref(base, { ...p, archived: true, page: 1 })}
          clearHref={isDefaultClientList(p) ? null : base}
          actions={p.q ? <a className={cn(outlineLink, hideWhileFormOpen)} href="#add-client">Add client</a> : null}
        >
          {p.q ? "Search covers names, emails and phone numbers. Not on file yet? Add them as a new client." : null}
        </NoResults>
      )}
    </>
  );
}
