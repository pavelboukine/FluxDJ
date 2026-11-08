import type { Metadata } from "next";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextField } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { ppmToPercent, readTaxSettings, usageText, type CategoryUsage } from "@/lib/pricing/tax-settings";
import { saveDepositPercent, saveTaxSettings } from "../../actions";
import { ReadOnlyRow, ReadOnlyRows, SettingsSection } from "../../settings-section";
import { TaxSettingsForm } from "../../tax-settings-form";

export const metadata: Metadata = { title: "Taxes & payments · Flux DJ" };

export default async function TaxSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/taxes">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const [{ data: settings }, usage] = await Promise.all([
    supabase.from("tenants").select("tax_config, tax_categories, tax_settings_version, currency, deposit_percent").eq("id", tenant.id).single(),
    categoryUsage(supabase, tenant.id),
  ]);
  const tax = readTaxSettings(settings?.tax_config, settings?.tax_categories);
  const shownCategories = [...new Set(["standard", ...usage.map((u) => u.key), ...Object.keys(tax.categories)])].sort((a, b) =>
    a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b),
  );
  const labelOf = (code: string) => tax.rates.find((r) => r.code === code)?.label ?? code;

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader
        title="Taxes & payments"
        description={`The deposit you ask for, and the taxes added to your prices, in ${settings?.currency}. Flux DJ doesn't take payments: you record them on the event page.`}
      />

      <SettingsSection
        id="deposit"
        title="Deposit"
        description="Contracts generated from a proposal use this percentage of the approved total, including taxes, rounded half up to the cent. A draft must be regenerated before it can be sent with a new percentage; sent and signed contracts never change."
      >
        {membership.role === "owner" ? (
          <ActionForm action={saveDepositPercent.bind(null, slug)} submitLabel="Save changes" trackUnsaved>
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
              inputClassName="w-24"
              hint="A whole number from 0 to 100."
            />
          </ActionForm>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Only the owner can change this.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Deposit due on signing">{settings?.deposit_percent}%</ReadOnlyRow>
            </ReadOnlyRows>
          </>
        )}
      </SettingsSection>

      {membership.role === "owner" ? (
        <div id="taxes" className="max-w-2xl min-w-0 scroll-mt-20 border-t pt-8">
          <TaxSettingsForm
            action={saveTaxSettings.bind(null, slug)}
            version={settings?.tax_settings_version ?? 1}
            rates={tax.rates}
            categories={tax.categories}
            usage={usage}
          />
        </div>
      ) : (
        <>
          <SettingsSection id="taxes" title="Taxes" description="Proposals can't be sent while a category they use has no taxes set.">
            <p role="status" className="text-sm text-muted-foreground">Only the owner can change tax settings.</p>
            {tax.rates.length ? (
              <ReadOnlyRows>
                {tax.rates.map((r) => (
                  <ReadOnlyRow key={r.code} label={r.label}>{ppmToPercent(r.rate_ppm)}%</ReadOnlyRow>
                ))}
              </ReadOnlyRows>
            ) : (
              <p className="text-sm text-muted-foreground">No taxes configured.</p>
            )}
          </SettingsSection>
          <SettingsSection title="Tax categories">
            <ReadOnlyRows>
              {shownCategories.map((key) => {
                const codes = tax.categories[key];
                return (
                  <ReadOnlyRow key={key} label={key} hint={usageText(usage.find((u) => u.key === key))}>
                    {codes === undefined ? (
                      <span className="font-normal text-amber-700 dark:text-amber-400">Not configured: offers using it can&apos;t be sent.</span>
                    ) : codes.length === 0 ? (
                      "No tax"
                    ) : (
                      codes.map(labelOf).join(" + ")
                    )}
                  </ReadOnlyRow>
                );
              })}
            </ReadOnlyRows>
          </SettingsSection>
        </>
      )}
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
