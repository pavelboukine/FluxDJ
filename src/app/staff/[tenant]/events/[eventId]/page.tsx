import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, PageHeader, SelectField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { ContractCard } from "../../contracts/contract-card";
import { UUID_RE } from "@/lib/forms";
import { addEventContact, openProposalDraft, removeEventContact, updateEvent } from "../actions";
import { EventFields } from "../event-fields";
import { eventStatusLabel } from "@/lib/events/status";
import { ArchivePanel } from "./archive-panel";
import { PaymentsCard } from "./payments-card";
import { RemoveContact } from "./remove-contact";

export default async function EventPage({ params, searchParams }: PageProps<"/staff/[tenant]/events/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  const { contact } = await searchParams;
  if (!UUID_RE.test(eventId)) notFound();
  const staff = await requireStaff(slug);
  const { supabase, tenant } = staff;
  const { data: event } = await supabase
    .from("events")
    .select("id, title, event_type, event_date, timezone, venue_name, venue_address, internal_notes, lifecycle_status, active_proposal_id, archived_at, event_clients(id, is_primary, can_sign, clients(id, name, email)), proposals!proposals_event_fk(id, revision, status, offer_frozen_at, updated_at, expires_at)")
    .eq("id", eventId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!event) notFound();
  const [{ data: clients }, { data: templates }] = await Promise.all([
    supabase.from("clients").select("id, name, email").eq("tenant_id", tenant.id).is("archived_at", null).order("name"),
    supabase.from("proposal_templates").select("id, name").eq("tenant_id", tenant.id).eq("active", true).order("name"),
  ]);
  // The current approval, if the active proposal is approved; contracts are generated from it.
  const activeApproved = event.proposals.find((p) => p.id === event.active_proposal_id && p.status === "approved");
  const [{ data: approval }, { count: contractCount }, { count: signedCount }] = await Promise.all([
    activeApproved
      ? supabase.from("proposal_approvals").select("id").eq("tenant_id", tenant.id).eq("proposal_id", activeApproved.id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("event_id", event.id),
    supabase.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("event_id", event.id).eq("status", "signed"),
  ]);
  const approvalId = approval?.id ?? null;
  const hasContracts = (contractCount ?? 0) > 0;
  const hasSignedContract = (signedCount ?? 0) > 0;
  const onEvent = new Set(event.event_clients.map((c) => c.clients?.id));
  const draft = event.proposals.find((p) => p.status === "draft");
  const proposals = [...event.proposals].sort((a, b) => b.revision - a.revision);

  return (
    <>
      <PageHeader
        title={event.title}
        description={<><Link className="underline" href={`/staff/${slug}/events`}>Back to events</Link> · {event.event_date}</>}
        actions={
          <>
            {event.archived_at ? <Badge variant="secondary">Archived</Badge> : null}
            <Badge variant="outline">{eventStatusLabel(event.lifecycle_status, hasSignedContract)}</Badge>
          </>
        }
      />
      {event.archived_at ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This event is archived. It is hidden from the events list, its client links are revoked, and proposals can&apos;t be sent or
          approved and contracts can&apos;t be generated until you unarchive it. Its history is kept.
        </p>
      ) : null}
      {contact === "failed" ? <p role="alert" className="text-sm text-destructive">The event was created but its contact could not be attached. Add the contact below.</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Proposal</CardTitle>
          <CardDescription>
            Each event has one editable draft. Editing never sends or freezes anything; the offer is frozen only when it is sent (next step).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {hasSignedContract ? (
            <p role="status" className="text-sm">
              A contract has been signed for this event, so its terms can&apos;t be revised. Amendments aren&apos;t available yet.
            </p>
          ) : null}
          {draft ? (
            <Link className="underline" href={`/staff/${slug}/proposals/${draft.id}`}>
              Continue the draft (revision {draft.revision})
            </Link>
          ) : hasSignedContract ? null : (
            <ActionForm action={openProposalDraft.bind(null, slug, event.id)} submitLabel={event.active_proposal_id ? "Start a revised offer" : "Start proposal draft"} pendingLabel="Opening…">
              <SelectField
                label="Start from template"
                name="template_id"
                options={(templates ?? []).map((t) => ({ value: t.id, label: t.name }))}
                placeholder={event.active_proposal_id ? "— the current offer —" : "— blank proposal —"}
              />
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

      {approvalId || hasContracts ? (
        <ContractCard staff={staff} slug={slug} eventId={event.id} approvalId={approvalId} />
      ) : null}

      <PaymentsCard staff={staff} slug={slug} eventId={event.id} archived={Boolean(event.archived_at)} />

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
        <CardHeader>
          <CardTitle>{event.archived_at ? "Archived" : "Archive"}</CardTitle>
          <CardDescription>Archiving is separate from cancelling or booking. Nothing is deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          <ArchivePanel slug={slug} eventId={event.id} archived={Boolean(event.archived_at)} />
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
