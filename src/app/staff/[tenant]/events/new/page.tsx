import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { contractsUseClientPhone } from "@/lib/clients.server";
import { UUID_RE } from "@/lib/forms";
import { searchClients } from "../../clients/actions";
import { createEvent } from "../actions";
import { EventFields } from "../event-fields";
import { PrimaryContact } from "./primary-contact";

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
  const [initial, anyClient, contractsNeedPhone] = await Promise.all([
    preselect
      ? supabase.from("clients").select("id, name, email, phone").eq("tenant_id", tenant.id).eq("id", preselect).is("archived_at", null).maybeSingle().then((r) => r.data)
      : null,
    supabase.from("clients").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).is("archived_at", null).then((r) => (r.count ?? 0) > 0),
    contractsUseClientPhone(supabase, tenant.id),
  ]);
  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="New event" description="Find or add the client, enter what you know about the event, then start a proposal." />
      <Card>
        <CardContent>
          <ActionForm action={createEvent.bind(null, slug)} submitLabel="Create event" pendingLabel="Creating…">
            <Card className="bg-muted/30">
              <CardHeader><CardTitle className="text-base">Primary contact</CardTitle></CardHeader>
              <CardContent>
                <PrimaryContact search={searchClients.bind(null, slug)} initial={initial} hasClients={anyClient} contractsNeedPhone={contractsNeedPhone} />
              </CardContent>
            </Card>
            <EventFields defaultTimezone={tenant.timezone} />
            <p className="text-xs text-muted-foreground">Only the title and date are needed now. Venue details can be added later from the event page.</p>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
