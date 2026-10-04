import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { eventStatusLabel } from "@/lib/events/status";

export default async function Events({ params, searchParams }: PageProps<"/staff/[tenant]/events">) {
  const { tenant: slug } = await params;
  const { show } = await searchParams;
  const includeArchived = show === "all";
  const { supabase, tenant } = await requireStaff(slug);
  // Archived events are hidden unless staff ask for them.
  let query = supabase
    .from("events")
    .select("id, title, event_date, lifecycle_status, archived_at, venue_name, event_clients(is_primary, clients(name))")
    .eq("tenant_id", tenant.id);
  if (!includeArchived) query = query.is("archived_at", null);
  const [{ data: events }, { data: signed }] = await Promise.all([
    query.order("event_date"),
    supabase.from("contracts").select("event_id").eq("tenant_id", tenant.id).eq("status", "signed"),
  ]);
  const signedEvents = new Set((signed ?? []).map((c) => c.event_id));
  return (
    <>
      <PageHeader
        title="Events"
        actions={
          <>
            <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/events${includeArchived ? "" : "?show=all"}`}>
              {includeArchived ? "Hide archived" : "Include archived"}
            </Link>
            <Link className={buttonVariants()} href={`/staff/${slug}/events/new`}>New event</Link>
          </>
        }
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Event</TableHead>
            <TableHead className="hidden sm:table-cell">Primary contact</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(events ?? []).map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">{e.event_date}</TableCell>
              <TableCell>
                <Link className="font-medium hover:underline" href={`/staff/${slug}/events/${e.id}`}>{e.title}</Link>
                {e.venue_name ? <div className="text-xs text-muted-foreground">{e.venue_name}</div> : null}
              </TableCell>
              <TableCell className="hidden sm:table-cell">{e.event_clients.find((c) => c.is_primary)?.clients?.name ?? "—"}</TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  <Badge variant="outline">{eventStatusLabel(e.lifecycle_status, signedEvents.has(e.id))}</Badge>
                  {e.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
          {events?.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No events yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
