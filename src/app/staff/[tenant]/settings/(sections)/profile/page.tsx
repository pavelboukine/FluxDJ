import type { Metadata } from "next";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { saveBusinessSettings, saveReplyTo } from "../../actions";
import { ReadOnlyRow, ReadOnlyRows, SettingsSection } from "../../settings-section";

export const metadata: Metadata = { title: "Business profile · Flux DJ" };

export default async function BusinessProfileSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/profile">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("business_name, display_name, business_address, contact_email, timezone, currency, reply_to_email")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";
  // Never saved (update_business_settings sets address and email together): the legal
  // name is still the placeholder copied from the display name at sign-up.
  const legalNamePending = !settings?.business_address && !settings?.contact_email;

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="Business profile" description="The name clients see, the details printed on your contracts, and where client replies go." />

      <SettingsSection title="Workspace" description="Set when your workspace was created. These can't be changed here.">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          {([["Display name", settings?.display_name], ["Time zone", settings?.timezone], ["Currency", settings?.currency]] as const).map(([label, value]) => (
            <div key={label} className="grid min-w-0 content-start gap-0.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>

      <SettingsSection
        id="legal"
        title="Contract details"
        description="Contracts can't be sent until these are saved. New contracts copy them; existing drafts keep theirs until you regenerate them, and signed contracts never change."
      >
        {isOwner ? (
          <ActionForm action={saveBusinessSettings.bind(null, slug)} submitLabel="Save changes" trackUnsaved>
            <TextField
              label="Legal business name"
              name="legal_name"
              required
              maxLength={200}
              defaultValue={legalNamePending ? "" : (settings?.business_name ?? "")}
              inputClassName="max-w-md"
              hint={legalNamePending ? `Not confirmed yet. Until you save it, contracts can't be sent and drafts show “${settings?.business_name}” as a placeholder.` : "As registered. Contracts use it; clients otherwise see your display name."}
            />
            <TextAreaField label="Business address" name="business_address" required rows={3} maxLength={500} defaultValue={settings?.business_address ?? ""} className="max-w-md" hint="Printed in contracts." />
            <TextField label="Contact email" name="contact_email" type="email" required maxLength={320} defaultValue={settings?.contact_email ?? ""} inputClassName="max-w-md" hint="Printed in contracts, for clients to reach you." />
          </ActionForm>
        ) : (
          <>
            <p role="status" className="text-sm text-muted-foreground">Only the owner can change business settings.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Legal business name">{legalNamePending ? "Not set" : settings?.business_name}</ReadOnlyRow>
              <ReadOnlyRow label="Business address">{settings?.business_address ?? "Not set"}</ReadOnlyRow>
              <ReadOnlyRow label="Contact email">{settings?.contact_email ?? "Not set"}</ReadOnlyRow>
            </ReadOnlyRows>
          </>
        )}
      </SettingsSection>

      <SettingsSection id="reply-to" title="Replies and notifications" description="Where email comes back to you. This address isn't printed on contracts.">
        {isOwner ? (
          <ActionForm action={saveReplyTo.bind(null, slug)} submitLabel="Save changes" trackUnsaved>
            <TextField
              label="Reply-to email"
              name="reply_to_email"
              type="email"
              maxLength={320}
              autoComplete="email"
              defaultValue={settings?.reply_to_email ?? ""}
              inputClassName="max-w-md"
              hint="Clients' replies to your emails and staff notifications (a proposal was submitted, a contract was signed) go here. If it's empty, notifications go to the owner's sign-in email and client emails have no reply-to."
            />
          </ActionForm>
        ) : (
          <ReadOnlyRows>
            <ReadOnlyRow
              label="Reply-to email"
              hint={settings?.reply_to_email ? "Clients' replies to your emails and staff notifications go here." : "Staff notifications go to the owner's sign-in email."}
            >
              {settings?.reply_to_email ?? "No reply-to address"}
            </ReadOnlyRow>
          </ReadOnlyRows>
        )}
      </SettingsSection>
    </>
  );
}
