import { Card, CardContent } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { contractsUseClientPhone } from "@/lib/clients.server";
import { UUID_RE } from "@/lib/forms";
import { searchClients } from "../../clients/actions";
import { createEvent } from "../actions";
import { EventFields } from "../event-fields";
import { BookingAndContact } from "./booking-source";

/**
 * Create an event and its primary contact: find an existing client (or open
 * this page from a client's page, `?client=<id>`, to preselect them) or add
 * a new one. Only the title, date and the contact's name and email are
 * needed now; the phone hint says when a phone will be needed.
 */
export default async function NewEvent({ params, searchParams }: PageProps<"/staff/[tenant]/events/new">) {
  const { tenant: slug } = await params;
  const { from, client: clientParam } = await searchParams;
  const { supabase, tenant } = await requireStaff(slug);
  const preselect = typeof clientParam === "string" && UUID_RE.test(clientParam) ? clientParam : null;
  const [initial, anyClient, contractsNeedPhone, proposalDefault] = await Promise.all([
    preselect
      ? supabase.from("clients").select("id, name, email, phone").eq("tenant_id", tenant.id).eq("id", preselect).is("archived_at", null).maybeSingle().then((r) => r.data)
      : null,
    supabase.from("clients").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).is("archived_at", null).then((r) => (r.count ?? 0) > 0),
    contractsUseClientPhone(supabase, tenant.id),
    supabase.from("tenants").select("proposals_by_default").eq("id", tenant.id).single().then((r) => r.data?.proposals_by_default ?? true),
  ]);
  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="Create event" description="Choose how the event is booked, find or add the client, and enter what you know about the event." />
      <Card>
        <CardContent>
          <ActionForm action={createEvent.bind(null, slug)} submitLabel="Create event" pendingLabel="Creating…">
            <BookingAndContact search={searchClients.bind(null, slug)} initial={initial} hasClients={anyClient} contractsNeedPhone={contractsNeedPhone} proposalDefault={proposalDefault} />
            <EventFields defaultTimezone={tenant.timezone} />
            <p className="text-xs text-muted-foreground">Only the title and date are needed now. Venue details can be added later from the event page. For an event booked elsewhere, internal notes are a good place for the agency or booking reference.</p>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
