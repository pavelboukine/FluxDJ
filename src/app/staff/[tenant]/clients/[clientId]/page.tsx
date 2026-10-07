import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { updateClientRecord } from "../actions";
import { ClientFields } from "../client-fields";
import { ClientArchivePanel } from "./client-archive-panel";

export default async function ClientPage({ params }: PageProps<"/staff/[tenant]/clients/[clientId]">) {
  const { tenant: slug, clientId } = await params;
  if (!UUID_RE.test(clientId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, email, phone, archived_at, event_clients(is_primary, events(id, title, event_date))")
    .eq("id", clientId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!client) notFound();
  return (
    <>
      <PageHeader
        title={client.name}
        description={<Link className="underline" href={`/staff/${slug}/clients`}>Back to clients</Link>}
        actions={client.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
      />
      {client.archived_at ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This client is archived. They stay on their events and documents, but can&apos;t be chosen for new events or contacts, and proposals
          or contracts can&apos;t be sent to them until you restore them.
        </p>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Contact details</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updateClientRecord.bind(null, slug, client.id)} submitLabel="Save client">
            <ClientFields client={client} />
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Events</CardTitle></CardHeader>
        <CardContent>
          <ul className="grid gap-1 text-sm">
            {client.event_clients.map((ec) =>
              ec.events ? (
                <li key={ec.events.id}>
                  <Link className="underline" href={`/staff/${slug}/events/${ec.events.id}`}>{ec.events.title}</Link> ({ec.events.event_date})
                  {ec.is_primary ? " · primary contact" : ""}
                </li>
              ) : null,
            )}
            {client.event_clients.length === 0 ? <li className="text-muted-foreground">No events yet.</li> : null}
          </ul>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{client.archived_at ? "Archived" : "Manage client"}</CardTitle>
          <CardDescription>Archiving hides a client from new work. Nothing is deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          <ClientArchivePanel slug={slug} clientId={client.id} name={client.name} archived={Boolean(client.archived_at)} events={client.event_clients.length} />
        </CardContent>
      </Card>
    </>
  );
}
