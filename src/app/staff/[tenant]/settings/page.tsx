import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { saveBusinessSettings } from "./actions";

export default async function BusinessSettings({ params }: PageProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("business_name, display_name, business_address, contact_email, deposit_percent")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";

  return (
    <>
      <PageHeader
        title="Business settings"
        description="Your legal identity and deposit terms for contracts. Clients see your display name on proposals; contracts use the legal details."
      />
      <Card>
        <CardHeader>
          <CardTitle>Legal identity and deposit</CardTitle>
          <CardDescription>
            New contracts copy these values when they are generated. Existing drafts keep what they were generated with until you
            regenerate them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isOwner ? (
            <ActionForm action={saveBusinessSettings.bind(null, slug)} submitLabel="Save settings" trackUnsaved>
              <TextField label="Legal business name" name="legal_name" required maxLength={200} defaultValue={settings?.business_name ?? ""} />
              <TextAreaField label="Business address" name="business_address" required rows={3} maxLength={500} defaultValue={settings?.business_address ?? ""} />
              <TextField label="Contact email" name="contact_email" type="email" required maxLength={320} defaultValue={settings?.contact_email ?? ""} />
              <TextField
                label="Deposit due on signing (%)"
                name="deposit_percent"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                required
                defaultValue={settings?.deposit_percent ?? 50}
                hint="A whole number from 0 to 100, applied to the approved total including taxes and rounded half up to the cent."
              />
            </ActionForm>
          ) : (
            <dl className="grid gap-2 text-sm">
              <p role="status" className="text-muted-foreground">Only the owner can change business settings.</p>
              <div><dt className="text-muted-foreground">Legal business name</dt><dd>{settings?.business_name}</dd></div>
              <div><dt className="text-muted-foreground">Business address</dt><dd className="whitespace-pre-wrap">{settings?.business_address ?? "Not set"}</dd></div>
              <div><dt className="text-muted-foreground">Contact email</dt><dd>{settings?.contact_email ?? "Not set"}</dd></div>
              <div><dt className="text-muted-foreground">Deposit</dt><dd>{settings?.deposit_percent}%</dd></div>
            </dl>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Display name (branding, not changed here): {settings?.display_name}</p>
        </CardContent>
      </Card>
    </>
  );
}
