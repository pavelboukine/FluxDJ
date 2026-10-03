import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, SelectField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { ClientFields } from "../../clients/client-fields";
import { createEvent } from "../actions";
import { EventFields } from "../event-fields";

export default async function NewEvent({ params }: PageProps<"/staff/[tenant]/events/new">) {
  const { tenant: slug } = await params;
  const { supabase, tenant } = await requireStaff(slug);
  const { data: clients } = await supabase.from("clients").select("id, name, email").eq("tenant_id", tenant.id).is("archived_at", null).order("name");
  return (
    <>
      <PageHeader title="New event" description="Create the event and its primary contact, then start a proposal." />
      <Card>
        <CardContent>
          <ActionForm action={createEvent.bind(null, slug)} submitLabel="Create event">
            <EventFields defaultTimezone={tenant.timezone} />
            <Card className="bg-muted/30">
              <CardHeader><CardTitle className="text-base">Primary contact</CardTitle></CardHeader>
              <CardContent className="grid gap-4">
                <SelectField
                  label="Client"
                  name="client_id"
                  defaultValue="new"
                  options={[{ value: "new", label: "➕ New client (enter below)" }, ...(clients ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.email})` }))]}
                  hint="Receives the proposal and signs the contract in later steps."
                />
                <ClientFields optional />
                <p className="text-xs text-muted-foreground">The fields above are used only when “New client” is selected.</p>
              </CardContent>
            </Card>
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
