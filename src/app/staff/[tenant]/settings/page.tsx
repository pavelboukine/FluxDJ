import type { ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextAreaField, TextField } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { ppmToPercent, readTaxSettings, usageText, type CategoryUsage } from "@/lib/pricing/tax-settings";
import { CUTOFF_DAYS_MAX, CUTOFF_DAYS_MIN } from "@/lib/planning/cutoff";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandTheme, normalizeHex } from "@/lib/branding/colors";
import { logoUrl } from "@/lib/branding/logo.server";
import { EVENT_TYPES } from "../events/event-form";
import { saveBookingPolicy, saveBranding, saveBusinessSettings, savePlanningCutoff, saveReplyTo, saveTaxSettings } from "./actions";
import { BrandingForm } from "./branding-form";
import { TaxSettingsForm } from "./tax-settings-form";

const SECTIONS = [
  ["profile", "Business profile"],
  ["branding", "Branding"],
  ["bookings", "Bookings and taxes"],
  ["planning-defaults", "Planning"],
  ["access", "Access"],
] as const;

function Section({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="grid scroll-mt-20 gap-4">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, hint }: { label: string; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}

const BOOKING_STEPS: [string, string][] = [
  ["Proposal sent and submitted", "The client chooses a package and extras and submits their choices. Nothing is booked yet."],
  ["Proposal approved", "You approve the submitted choices. Its prices and taxes are then fixed, and you can generate a contract from it."],
  ["Contract signed", "The client signs the contract you sent. The signed copy and its evidence never change."],
  ["Deposit recorded", "You record payments yourself on the event page. Flux doesn't take payments."],
  ["Booking confirmed", "Flux confirms the booking automatically once the policy below is met, emails the client, and planning opens to them."],
];

export default async function BusinessSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("business_name, display_name, business_address, contact_email, deposit_percent, tax_config, tax_categories, tax_settings_version, booking_confirmation_policy, booking_policy_version, planning_lock_days, planning_settings_version, brand_colors, logo_storage_path, branding_version, timezone, currency, reply_to_email")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";
  const [{ data: activeLogo }, { data: defaults }, { data: members }, usage] = await Promise.all([
    settings?.logo_storage_path
      ? supabase.from("tenant_logos").select("storage_path, needs_dark_background, width, height").eq("tenant_id", tenant.id).eq("storage_path", settings.logo_storage_path).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("planning_templates").select("id, name, default_event_type").eq("tenant_id", tenant.id).is("archived_at", null).not("default_event_type", "is", null),
    supabase.from("tenant_memberships").select("role").eq("tenant_id", tenant.id).is("removed_at", null),
    categoryUsage(supabase, tenant.id),
  ]);
  const currentLogo = await logoUrl(activeLogo);
  const primaryColor = normalizeHex((settings?.brand_colors as Record<string, unknown> | null)?.primary);
  // Never saved (update_business_settings sets address and email together): the legal
  // name is still the placeholder copied from the display name at sign-up.
  const legalNamePending = !settings?.business_address && !settings?.contact_email;
  const tax = readTaxSettings(settings?.tax_config, settings?.tax_categories);
  const shownCategories = [...new Set(["standard", ...usage.map((u) => u.key), ...Object.keys(tax.categories)])].sort((a, b) =>
    a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b),
  );
  const labelOf = (code: string) => tax.rates.find((r) => r.code === code)?.label ?? code;
  const owners = (members ?? []).filter((m) => m.role === "owner").length;
  const staff = (members ?? []).filter((m) => m.role !== "owner").length;
  const onSignature = settings?.booking_confirmation_policy === "on_signature";

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader
        title="Business settings"
        description="How your business appears to clients, what new contracts and proposals copy, and your planning defaults. Changes never alter proposals already sent or contracts already generated."
        actions={
          <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}/setup`}>
            Setup guide
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:self-start">
          <ul className="flex flex-wrap gap-1.5 lg:grid lg:gap-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-lg border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:border-transparent lg:px-3"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="grid min-w-0 gap-10">
          <Section
            id="profile"
            title="Business profile"
            description="Your display name is what clients see. Your legal details appear in contracts."
          >
            <Card>
              <CardHeader>
                <CardTitle>Workspace</CardTitle>
                <CardDescription>Your display name, time zone and currency were set when your workspace was created and can&apos;t be changed here.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <Fact label="Display name" value={settings?.display_name} hint="Shown to clients on proposals, contracts and planning, and in your workspace header when there is no logo." />
                  <Fact label="Time zone" value={settings?.timezone} hint="New events start in this time zone; each event keeps its own." />
                  <Fact label="Currency" value={settings?.currency} hint="Your prices, proposals and payments use it." />
                  {isOwner ? null : (
                    <Fact
                      label="Replies and notifications"
                      value={settings?.reply_to_email ?? "No reply-to address"}
                      hint={
                        settings?.reply_to_email
                          ? "Clients' replies to your emails and staff notifications go here."
                          : "Staff notifications go to the owner's sign-in email."
                      }
                    />
                  )}
                </dl>
                {isOwner ? (
                  <div id="reply-to" className="mt-5 scroll-mt-20 border-t pt-4">
                    <ActionForm action={saveReplyTo.bind(null, slug)} submitLabel="Save reply-to" trackUnsaved>
                      <TextField
                        label="Reply-to email"
                        name="reply_to_email"
                        type="email"
                        maxLength={320}
                        autoComplete="email"
                        defaultValue={settings?.reply_to_email ?? ""}
                        className="max-w-md"
                        hint="When clients reply to an email from your business, the reply goes here. Staff notifications (a proposal was submitted, a contract was signed) go here too. Leave it empty to use the owner's sign-in email for notifications; client emails then have no reply-to."
                      />
                    </ActionForm>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card id="legal" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>Legal details and deposit</CardTitle>
                <CardDescription>
                  Contracts can&apos;t be sent until these are saved. New contracts copy them when they are generated, through placeholders such as
                  {" "}<code className="text-xs">{"{{business.legal_name}}"}</code>; existing drafts keep their values until you regenerate them,
                  and signed contracts never change.
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
                      hint={legalNamePending ? `Not confirmed yet. Until you save it, contracts can't be sent and drafts show “${settings?.business_name}” as a placeholder.` : "As registered. Contracts use it; clients otherwise see your display name."}
                    />
                    <TextAreaField label="Business address" name="business_address" required rows={3} maxLength={500} defaultValue={settings?.business_address ?? ""} hint="Printed in contracts." />
                    <TextField label="Contact email" name="contact_email" type="email" required maxLength={320} defaultValue={settings?.contact_email ?? ""} hint="Printed in contracts, for clients to reach you." />
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
                      className="max-w-[12rem]"
                      hint="A whole number from 0 to 100, applied to the approved total including taxes and rounded half up to the cent. Saved with your legal details."
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
              </CardContent>
            </Card>
          </Section>

          <Section id="branding-section" title="Branding" description="Your logo and colour make your client pages look like your business. Both are optional.">
            <Card id="branding" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>Logo and colour</CardTitle>
                <CardDescription>
                  Shown in your workspace header, on client contract and planning pages, and on proposals you send from now on. Proposals
                  already sent keep the branding they were sent with. Signed contract PDFs and emails don&apos;t show a logo.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isOwner ? (
                  <BrandingForm
                    action={saveBranding.bind(null, slug)}
                    version={settings?.branding_version ?? 0}
                    displayName={settings?.display_name ?? tenant.display_name}
                    currentLogo={currentLogo}
                    currentColor={primaryColor}
                  />
                ) : (
                  <dl className="grid gap-3 text-sm">
                    <p role="status" className="text-muted-foreground">Only the owner can change branding.</p>
                    <div className="grid gap-1">
                      <dt className="text-muted-foreground">Logo</dt>
                      <dd>{currentLogo ? <BrandLogo logo={currentLogo} name={tenant.display_name} className="max-h-12 max-w-48" /> : "None (the business name is shown)"}</dd>
                    </div>
                    <div className="grid gap-1">
                      <dt className="text-muted-foreground">Primary colour</dt>
                      <dd className="flex items-center gap-2">
                        <span aria-hidden className="size-4 rounded border" style={{ background: brandTheme(primaryColor).color }} />
                        {primaryColor ?? "Default"}
                      </dd>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
          </Section>

          <Section
            id="bookings"
            title="Bookings and taxes"
            description={`When a booking is confirmed and the taxes added to your prices (in ${settings?.currency}). Each proposal and contract keeps the settings it was created with.`}
          >
            <details className="group rounded-xl border bg-card px-4 py-3 text-sm" data-testid="booking-steps">
              <summary className="cursor-pointer font-medium marker:text-muted-foreground">From proposal to confirmed booking</summary>
              <ol className="mt-3 grid list-decimal gap-2 pl-5">
                {BOOKING_STEPS.map(([title, text]) => (
                  <li key={title}>
                    <span className="font-medium">{title}.</span> <span className="text-muted-foreground">{text}</span>
                  </li>
                ))}
              </ol>
            </details>

            <Card id="booking" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>Booking confirmation</CardTitle>
                <CardDescription>
                  Flux DJ confirms a booking automatically when this policy is met, and emails the client a booking confirmation. Each contract
                  keeps the policy it was generated with, so a change applies only to contracts generated afterwards.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <p data-testid="deposit-summary">
                  <span className="text-muted-foreground">Deposit due on signing: </span>
                  <span className="font-medium">{settings?.deposit_percent}%</span>
                  {" "}
                  <a className="text-muted-foreground underline underline-offset-4 hover:text-foreground" href="#legal">
                    {isOwner ? "Change it with your legal details" : "Set with the legal details"}
                  </a>
                </p>
                {isOwner ? (
                  <ActionForm action={saveBookingPolicy.bind(null, slug)} version={settings?.booking_policy_version ?? 0} submitLabel="Save booking policy" trackUnsaved>
                    <fieldset className="grid gap-2">
                      <legend className="mb-1 font-medium">Confirm a booking when…</legend>
                      <label className="flex items-start gap-2">
                        <input type="radio" name="booking_policy" value="on_deposit" defaultChecked={!onSignature} className="mt-0.5 accent-primary" />
                        <span>
                          <span className="font-medium">the contract is signed and the deposit is received</span> (recommended). Checked when the
                          client signs and whenever you record or invalidate a payment; payments recorded before signing count. A 0% deposit
                          means signing is enough.
                        </span>
                      </label>
                      <label className="flex items-start gap-2">
                        <input type="radio" name="booking_policy" value="on_signature" defaultChecked={onSignature} className="mt-0.5 accent-primary" />
                        <span>
                          <span className="font-medium">the contract is signed.</span> The deposit and balance may still be outstanding.
                        </span>
                      </label>
                    </fieldset>
                  </ActionForm>
                ) : (
                  <p>
                    <span className="text-muted-foreground">Bookings are confirmed when </span>
                    {onSignature ? "the contract is signed." : "the contract is signed and the deposit is received."}
                    <span className="block text-muted-foreground">Only the owner can change this.</span>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  A recorded payment correction never cancels a booking; the event page warns you if the deposit is no longer covered.
                </p>
              </CardContent>
            </Card>

            <Card id="taxes" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>Taxes</CardTitle>
                <CardDescription>
                  The taxes you charge and which ones apply to each tax category. Nothing is filled in for you: enter the rates that match your
                  own registration. Proposals can&apos;t be sent while a category they use has no taxes set (&ldquo;No tax&rdquo; is a valid
                  choice). New offers copy these settings when they are sent.
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
          </Section>

          <Section
            id="planning-defaults"
            title="Planning"
            description="Defaults for client planning. Opening or closing one event's planning to the client is done from that event's planning page."
          >
            <Card id="planning" className="scroll-mt-20">
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

            <Card data-testid="planning-defaults">
              <CardHeader>
                <CardTitle>Templates by event type</CardTitle>
                <CardDescription>
                  When planning starts for a booked event, it gets its own copy of the default template for its type, unless staff choose
                  another. Changing a template later never changes plans already started.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <dl className="divide-y rounded-lg border">
                  {EVENT_TYPES.map(([key, label]) => {
                    const t = (defaults ?? []).find((d) => d.default_event_type === key);
                    return (
                      <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                        <dt>{label}</dt>
                        <dd className={t ? "font-medium" : "text-muted-foreground"}>
                          {t ? (
                            <Link className="underline-offset-4 hover:underline" href={`/staff/${slug}/planning-templates/${t.id}`}>{t.name}</Link>
                          ) : (
                            "No default: event basics only"
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Set or change a default on the template&apos;s page.{" "}
                  <Link className="font-medium text-foreground underline underline-offset-4" href={`/staff/${slug}/planning-templates`}>Manage planning templates</Link>
                </p>
              </CardContent>
            </Card>
          </Section>

          <Section id="access" title="Access" description="Who can change what in this workspace.">
            <Card>
              <CardContent className="grid gap-3 text-sm">
                <p data-testid="access-role">
                  You are {isOwner ? "an owner" : "a staff member"} of {tenant.display_name}. This workspace has{" "}
                  {owners === 1 ? "1 owner" : `${owners} owners`} and {staff === 1 ? "1 staff member" : `${staff} staff members`}.
                </p>
                <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
                  <li>Owners change these settings, branding and taxes, and publish contract templates for client use, and manage the team.</li>
                  <li>Staff see these settings read-only and work with events, clients, the catalog and templates.</li>
                  <li>Clients only ever see their own events, proposals, contracts and plans.</li>
                </ul>
                {isOwner ? (
                  <div>
                    <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`/staff/${slug}/team`}>Manage team</Link>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Only the owner can invite or remove team members.</p>
                )}
              </CardContent>
            </Card>
          </Section>
        </div>
      </div>
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
