import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { ppmToPercent, readTaxSettings, usageText, type CategoryUsage } from "@/lib/pricing/tax-settings";
import { CUTOFF_DAYS_MAX, CUTOFF_DAYS_MIN } from "@/lib/planning/cutoff";
import { saveBookingPolicy, saveBusinessSettings, savePlanningCutoff, saveTaxSettings } from "./actions";
import { TaxSettingsForm } from "./tax-settings-form";

export default async function BusinessSettings({ params }: PageProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("business_name, display_name, business_address, contact_email, deposit_percent, tax_config, tax_categories, tax_settings_version, booking_confirmation_policy, booking_policy_version, planning_lock_days, planning_settings_version")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";
  // Never saved (update_business_settings sets address and email together): the legal
  // name is still the placeholder copied from the display name at sign-up.
  const legalNamePending = !settings?.business_address && !settings?.contact_email;
  const tax = readTaxSettings(settings?.tax_config, settings?.tax_categories);
  const usage = await categoryUsage(supabase, tenant.id);
  const shownCategories = [...new Set(["standard", ...usage.map((u) => u.key), ...Object.keys(tax.categories)])].sort((a, b) =>
    a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b),
  );
  const labelOf = (code: string) => tax.rates.find((r) => r.code === code)?.label ?? code;

  return (
    <>
      <PageHeader
        title="Business settings"
        description="Your legal identity, deposit terms and taxes. Clients see your display name on proposals; contracts use the legal details."
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
              <TextField
                label="Legal business name"
                name="legal_name"
                required
                maxLength={200}
                defaultValue={legalNamePending ? "" : (settings?.business_name ?? "")}
                hint={legalNamePending ? `Not confirmed yet. Until you save it, contracts can't be sent and drafts show “${settings?.business_name}” as a placeholder.` : undefined}
              />
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
              <div><dt className="text-muted-foreground">Legal business name</dt><dd>{legalNamePending ? "Not set" : settings?.business_name}</dd></div>
              <div><dt className="text-muted-foreground">Business address</dt><dd className="whitespace-pre-wrap">{settings?.business_address ?? "Not set"}</dd></div>
              <div><dt className="text-muted-foreground">Contact email</dt><dd>{settings?.contact_email ?? "Not set"}</dd></div>
              <div><dt className="text-muted-foreground">Deposit</dt><dd>{settings?.deposit_percent}%</dd></div>
            </dl>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Display name (branding, not changed here): {settings?.display_name}</p>
        </CardContent>
      </Card>
      <Card id="booking" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Booking confirmation</CardTitle>
          <CardDescription>
            Flux DJ confirms a booking automatically when this policy is met, and emails the client a booking confirmation. Each contract
            keeps the policy it was generated with, so a change applies only to contracts generated afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {isOwner ? (
            <ActionForm action={saveBookingPolicy.bind(null, slug)} version={settings?.booking_policy_version ?? 0} submitLabel="Save booking policy" trackUnsaved>
              <fieldset className="grid gap-2">
                <legend className="mb-1 font-medium">Confirm a booking when…</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" name="booking_policy" value="on_deposit" defaultChecked={settings?.booking_confirmation_policy !== "on_signature"} className="mt-0.5 accent-primary" />
                  <span>
                    <span className="font-medium">the contract is signed and the deposit is received</span> (recommended). Checked when the
                    client signs and whenever you record or invalidate a payment; payments recorded before signing count. A 0% deposit
                    means signing is enough.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="booking_policy" value="on_signature" defaultChecked={settings?.booking_confirmation_policy === "on_signature"} className="mt-0.5 accent-primary" />
                  <span>
                    <span className="font-medium">the contract is signed.</span> The deposit and balance may still be outstanding.
                  </span>
                </label>
              </fieldset>
            </ActionForm>
          ) : (
            <p>
              <span className="text-muted-foreground">Bookings are confirmed when </span>
              {settings?.booking_confirmation_policy === "on_signature" ? "the contract is signed." : "the contract is signed and the deposit is received."}
              <span className="block text-muted-foreground">Only the owner can change this.</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            A recorded payment correction never cancels a booking; the event page warns you if the deposit is no longer covered.
          </p>
        </CardContent>
      </Card>
      <Card id="planning" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Planning deadline</CardTitle>
          <CardDescription>
            Clients can change their event planning until 00:00 (midnight, in the event&apos;s time zone) this many calendar days before the
            event date; after that it is read-only for them. You and your staff can always edit, and you can reopen or move one event&apos;s
            deadline from its planning page. Each plan keeps the days it was set up with, so a change applies only to plans set up
            afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {isOwner ? (
            <ActionForm action={savePlanningCutoff.bind(null, slug)} version={settings?.planning_settings_version ?? 0} submitLabel="Save planning deadline" trackUnsaved>
              <TextField
                key={settings?.planning_lock_days}
                label="Days before the event"
                name="planning_lock_days"
                type="number"
                inputMode="numeric"
                min={CUTOFF_DAYS_MIN}
                max={CUTOFF_DAYS_MAX}
                step={1}
                required
                defaultValue={settings?.planning_lock_days ?? 14}
                className="max-w-[10rem]"
                hint={`A whole number from ${CUTOFF_DAYS_MIN} (closes at the start of the event day) to ${CUTOFF_DAYS_MAX}. The default is 14.`}
              />
            </ActionForm>
          ) : (
            <p>
              <span className="text-muted-foreground">Client planning closes </span>
              {settings?.planning_lock_days ?? 14} days before the event.
              <span className="block text-muted-foreground">Only the owner can change this.</span>
            </p>
          )}
        </CardContent>
      </Card>
      <Card id="taxes" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Taxes</CardTitle>
          <CardDescription>
            The taxes you charge and which ones apply to each tax category. Nothing is filled in for you: enter the rates that match your
            own registration. New offers copy these settings when they are sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isOwner ? (
            <TaxSettingsForm
              action={saveTaxSettings.bind(null, slug)}
              version={settings?.tax_settings_version ?? 1}
              rates={tax.rates}
              categories={tax.categories}
              usage={usage}
            />
          ) : (
            <div className="grid gap-4 text-sm">
              <p role="status" className="text-muted-foreground">Only the owner can change tax settings.</p>
              <div>
                <h3 className="mb-1 font-medium">Taxes</h3>
                {tax.rates.length ? (
                  <ul className="grid gap-1">
                    {tax.rates.map((r) => (
                      <li key={r.code}>
                        {r.label}: {ppmToPercent(r.rate_ppm)}%
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">No taxes configured.</p>
                )}
              </div>
              <div>
                <h3 className="mb-1 font-medium">Tax categories</h3>
                <dl className="grid gap-2">
                  {shownCategories.map((key) => {
                    const codes = tax.categories[key];
                    return (
                      <div key={key}>
                        <dt className="font-mono">{key}</dt>
                        <dd>
                          {codes === undefined ? (
                            <span className="text-amber-700 dark:text-amber-400">Not configured: offers using it can&apos;t be sent.</span>
                          ) : codes.length === 0 ? (
                            "No tax"
                          ) : (
                            codes.map(labelOf).join(" + ")
                          )}{" "}
                          <span className="text-xs text-muted-foreground">{usageText(usage.find((u) => u.key === key))}</span>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** Tax categories used by active gear and packages, with counts. */
async function categoryUsage(supabase: Awaited<ReturnType<typeof requireStaff>>["supabase"], tenantId: string): Promise<CategoryUsage[]> {
  const [{ data: gear }, { data: packages }] = await Promise.all([
    supabase.from("gear_items").select("tax_category").eq("tenant_id", tenantId).eq("active", true),
    supabase.from("packages").select("tax_category").eq("tenant_id", tenantId).eq("active", true),
  ]);
  const counts = new Map<string, CategoryUsage>();
  const bump = (key: string, field: "gear" | "packages") => {
    const entry = counts.get(key) ?? { key, gear: 0, packages: 0 };
    entry[field] += 1;
    counts.set(key, entry);
  };
  for (const g of gear ?? []) bump(g.tax_category, "gear");
  for (const p of packages ?? []) bump(p.tax_category, "packages");
  return [...counts.values()];
}
