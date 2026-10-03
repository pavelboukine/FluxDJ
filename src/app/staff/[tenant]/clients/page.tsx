import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { createClientRecord } from "./actions";
import { ClientFields } from "./client-fields";

export default async function Clients({ params }: PageProps<"/staff/[tenant]/clients">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, email, phone, archived_at, event_clients(count)")
    .eq("tenant_id", tenant.id)
    .order("archived_at", { nullsFirst: true })
    .order("name");
  return (
    <>
      <PageHeader title="Clients" description="Contacts for your events. They are private to your business." />
      <Card>
        <CardHeader><CardTitle>Add a client</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={createClientRecord.bind(null, slug)} submitLabel="Add client" resetOnSuccess>
            <ClientFields />
          </ActionForm>
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="hidden sm:table-cell">Email</TableHead>
            <TableHead className="hidden sm:table-cell">Events</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(clients ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link className="font-medium hover:underline" href={`/staff/${slug}/clients/${c.id}`}>{c.name}</Link>
                <div className="text-xs text-muted-foreground sm:hidden">{c.email}</div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">{c.email}</TableCell>
              <TableCell className="hidden sm:table-cell">{c.event_clients[0]?.count ?? 0}</TableCell>
              <TableCell>{c.archived_at ? <Badge variant="outline">Archived</Badge> : <Badge variant="secondary">Active</Badge>}</TableCell>
            </TableRow>
          ))}
          {clients?.length === 0 ? <TableRow><TableCell colSpan={4} className="text-muted-foreground">No clients yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </>
  );
}
