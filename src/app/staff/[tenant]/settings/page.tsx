import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { ppmToPercent, readTaxSettings, usageText, type CategoryUsage } from "@/lib/pricing/tax-settings";
import { saveBusinessSettings, saveTaxSettings } from "./actions";
import { TaxSettingsForm } from "./tax-settings-form";

export default async function BusinessSettings({ params }: PageProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("business_name, display_name, business_address, contact_email, deposit_percent, tax_config, tax_categories, tax_settings_version")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";
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
