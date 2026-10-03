import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";

export default async function Events({ params }: PageProps<"/staff/[tenant]/events">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: events } = await supabase
    .from("events")
    .select("id, title, event_date, lifecycle_status, venue_name, event_clients(is_primary, clients(name))")
    .eq("tenant_id", tenant.id)
    .order("event_date");
  return (
    <>
      <PageHeader title="Events" actions={<Link className={buttonVariants()} href={`/staff/${slug}/events/new`}>New event</Link>} />
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
              <TableCell><Badge variant="outline">{e.lifecycle_status.replace("_", " ")}</Badge></TableCell>
            </TableRow>
          ))}
          {events?.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No events yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
