import type { Metadata } from "next";
import Link from "@/components/app/pending-link";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader, TextField } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { CUTOFF_DAYS_MAX, CUTOFF_DAYS_MIN } from "@/lib/planning/cutoff";
import { EVENT_TYPES } from "../../../events/event-form";
import { savePlanningCutoff, savePlanningDjName } from "../../actions";
import { ReadOnlyRow, ReadOnlyRows, SettingsSection } from "../../settings-section";

export const metadata: Metadata = { title: "Client planning · Flux DJ" };

export default async function ClientPlanningSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/planning">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const [{ data: settings }, { data: defaults }] = await Promise.all([
    supabase.from("tenants").select("planning_lock_days, planning_settings_version, dj_name").eq("id", tenant.id).single(),
    supabase.from("planning_templates").select("id, name, default_event_type").eq("tenant_id", tenant.id).is("archived_at", null).not("default_event_type", "is", null),
  ]);
  const isOwner = membership.role === "owner";

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="Client planning" description="Your business-wide defaults. Each event can differ: change one event from its details and planning pages." />

      <SettingsSection
        id="planning"
        title="Planning deadline"
        description="Clients can edit until midnight this many days before the event, in the event's time zone. After that, planning is read-only for them; you and your staff can always edit."
      >
        {isOwner ? (
          <ActionForm action={savePlanningCutoff.bind(null, slug)} version={settings?.planning_settings_version ?? 0} submitLabel="Save changes" trackUnsaved>
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
              inputClassName="w-24"
              hint={`A whole number from ${CUTOFF_DAYS_MIN} (closes at the start of the event day) to ${CUTOFF_DAYS_MAX}. The default is 14.`}
            />
          </ActionForm>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Only the owner can change this.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Client planning closes">{settings?.planning_lock_days ?? 14} days before the event.</ReadOnlyRow>
            </ReadOnlyRows>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Applies to plans set up from now on: each plan keeps the days it was set up with. To reopen or move one event&apos;s deadline, or open or close its planning, use that event&apos;s planning page.
        </p>
      </SettingsSection>

      <SettingsSection
        id="dj-name"
        title="DJ name"
        data-testid="planning-dj-name"
        description="Where planning asks who does what, clients see this name, for example “DJ Boukine (your DJ) will be the MC”. Everywhere else, they see your display name."
      >
        {isOwner ? (
          <ActionForm action={savePlanningDjName.bind(null, slug)} submitLabel="Save changes" trackUnsaved>
            <TextField
              key={settings?.dj_name ?? ""}
              label="DJ name (optional)"
              name="dj_name"
              maxLength={80}
              defaultValue={settings?.dj_name ?? ""}
              placeholder="DJ Boukine"
              inputClassName="max-w-sm"
              hint="An event can name its own DJ in its details. Leave this empty if different DJs handle your events: planning then says “your DJ”."
            />
          </ActionForm>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Only the owner can change this.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="DJ name" hint="An event can name its own DJ in its details.">
                {settings?.dj_name ?? <span className="font-normal text-muted-foreground">Not set: planning says &ldquo;your DJ&rdquo;.</span>}
              </ReadOnlyRow>
            </ReadOnlyRows>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Default templates"
        data-testid="planning-defaults"
        description="When planning starts for a booked event, it gets its own copy of the default template for its type, unless staff choose another. Changing a template later never changes plans already started."
      >
        <ReadOnlyRows>
          {EVENT_TYPES.map(([key, label]) => {
            const t = (defaults ?? []).find((d) => d.default_event_type === key);
            return (
              <ReadOnlyRow key={key} label={label}>
                {t ? (
                  <Link className="tap-target-y underline-offset-4 hover:underline" href={`/staff/${slug}/planning-templates/${t.id}`}>{t.name}</Link>
                ) : (
                  <span className="font-normal text-muted-foreground">No default: event basics only</span>
                )}
              </ReadOnlyRow>
            );
          })}
        </ReadOnlyRows>
        <p className="text-xs text-muted-foreground">
          Set or change a default on the template&apos;s page.{" "}
          <Link className="tap-target-y font-medium text-foreground underline underline-offset-4" href={`/staff/${slug}/planning-templates`}>Manage planning templates</Link>
        </p>
      </SettingsSection>
    </>
  );
}
