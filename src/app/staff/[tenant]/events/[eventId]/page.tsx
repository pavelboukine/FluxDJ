import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, SelectField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { addEventContact, openProposalDraft, removeEventContact, updateEvent } from "../actions";
import { EventFields } from "../event-fields";
import { RemoveContact } from "./remove-contact";

export default async function EventPage({ params, searchParams }: PageProps<"/staff/[tenant]/events/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  const { contact } = await searchParams;
  if (!UUID_RE.test(eventId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: event } = await supabase
    .from("events")
    .select("id, title, event_type, event_date, timezone, venue_name, venue_address, internal_notes, lifecycle_status, event_clients(id, is_primary, can_sign, clients(id, name, email)), proposals(id, revision, status, offer_frozen_at, updated_at)")
    .eq("id", eventId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!event) notFound();
  const [{ data: clients }, { data: templates }] = await Promise.all([
    supabase.from("clients").select("id, name, email").eq("tenant_id", tenant.id).is("archived_at", null).order("name"),
    supabase.from("proposal_templates").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name"),
  ]);
  const onEvent = new Set(event.event_clients.map((c) => c.clients?.id));
  const draft = event.proposals.find((p) => p.status === "draft");
  const proposals = [...event.proposals].sort((a, b) => b.revision - a.revision);

  return (
    <>
      <PageHeader
        title={event.title}
        description={<><Link className="underline" href={`/staff/${slug}/events`}>Back to events</Link> · {event.event_date}</>}
        actions={<Badge variant="outline">{event.lifecycle_status.replace("_", " ")}</Badge>}
      />
      {contact === "failed" ? <p role="alert" className="text-sm text-destructive">The event was created but its contact could not be attached. Add the contact below.</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Proposal</CardTitle>
          <CardDescription>
            Each event has one editable draft. Editing never sends or freezes anything; the offer is frozen only when it is sent (next step).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {draft ? (
            <Link className="underline" href={`/staff/${slug}/proposals/${draft.id}`}>
              Continue the draft (revision {draft.revision})
            </Link>
          ) : (
            <ActionForm action={openProposalDraft.bind(null, slug, event.id)} submitLabel="Start proposal draft" pendingLabel="Opening…">
              <SelectField label="Start from template" name="template_id" options={(templates ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="— blank proposal —" />
            </ActionForm>
          )}
          {proposals.length > 0 ? (
            <ul className="grid gap-1 text-sm">
              {proposals.map((p) => (
                <li key={p.id}>
                  <Link className="underline" href={`/staff/${slug}/proposals/${p.id}`}>Revision {p.revision}</Link> · {p.status}
                  {p.offer_frozen_at ? " · offer frozen" : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Contacts</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <ul className="grid gap-2 text-sm">
            {event.event_clients.map((ec) => (
              <li key={ec.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                <span>
                  {ec.clients?.name} <span className="text-muted-foreground">{ec.clients?.email}</span>{" "}
                  {ec.is_primary ? <Badge>Primary</Badge> : null} {ec.can_sign ? <Badge variant="secondary">Signer</Badge> : null}
                </span>
                <RemoveContact action={removeEventContact.bind(null, slug, event.id, ec.id)} />
              </li>
            ))}
            {event.event_clients.length === 0 ? <li className="text-muted-foreground">No contacts yet.</li> : null}
          </ul>
          <ActionForm action={addEventContact.bind(null, slug, event.id)} submitLabel="Add contact" className="sm:grid-cols-2" resetOnSuccess>
            <SelectField label="Client" name="client_id" options={(clients ?? []).filter((c) => !onEvent.has(c.id)).map((c) => ({ value: c.id, label: `${c.name} (${c.email})` }))} placeholder="— choose —" />
            <CheckboxField label="Make primary contact and signer" name="is_primary" />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Event details</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={updateEvent.bind(null, slug, event.id)} submitLabel="Save event">
            <EventFields event={event} defaultTimezone={tenant.timezone} />
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
