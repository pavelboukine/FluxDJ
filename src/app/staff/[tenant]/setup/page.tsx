import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/fields";
import { ProgressGlyph, type GlyphState } from "@/components/app/status-glyph";
import { requireStaff } from "@/lib/auth/staff";
import { UPCOMING_SHOWN, dashboardSchema } from "@/lib/dashboard";
import {
  GUIDANCE_OPTIONS,
  GUIDANCE_WORKFLOWS,
  fromSetup,
  isSetupGuidance,
  offerablePackages,
  readiness,
  setupGuide,
  taskStatusLabel,
  type SetupStatus,
  type SetupTask,
} from "@/lib/setup";
import { cn } from "@/lib/utils";
import { EVENT_TYPES } from "../events/event-form";
import { saveSetupGuidance } from "./actions";

const STATUS_STYLE: Record<SetupStatus, string> = {
  ready: "text-emerald-700 dark:text-emerald-400",
  attention: "text-amber-800 dark:text-amber-300",
  not_started: "text-foreground",
  optional: "text-muted-foreground",
  skipped: "text-muted-foreground",
};

const GLYPH: Record<SetupStatus, GlyphState> = {
  ready: "complete",
  attention: "in_progress",
  not_started: "not_started",
  optional: "not_started",
  skipped: "not_applicable",
};

/** A recommended step that isn't done yet reads calmly, like an optional one. */
const quiet = (t: Pick<SetupTask, "level" | "done" | "status">) => t.level === "recommended" && !t.done && t.status !== "skipped";

function TaskRow({ t, isOwner }: { t: SetupTask; isOwner: boolean }) {
  const shown: SetupStatus = quiet(t) ? "optional" : t.status;
  const view = t.done || (t.ownerOnly && !isOwner);
  return (
    <li data-testid={`setup-task-${t.key}`} data-status={t.status} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
      <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0">
        <ProgressGlyph state={GLYPH[shown]} className="mt-0.5" />
        <div className="grid min-w-0 gap-1 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="font-medium">{t.label}</h3>
            <span className={cn("text-xs font-medium", STATUS_STYLE[shown])} data-testid="setup-status">{taskStatusLabel(t)}</span>
          </div>
          <p className="text-muted-foreground">{t.description}</p>
          <p className="text-xs">
            <span className="text-muted-foreground">{t.needed}{t.ownerOnly ? " · Owner only" : ""}.</span> {t.hint}
          </p>
        </div>
      </div>
      <Link
        className={cn(buttonVariants({ variant: t.done ? "ghost" : "outline", size: "sm" }), "ml-7 sm:ml-0")}
        href={fromSetup(t.href)}
        aria-label={`${view ? "View" : t.action}: ${t.label}`}
      >
        {view ? "View" : t.action}
      </Link>
    </li>
  );
}

/**
 * The setup guide: what this business has saved, what each workflow still
 * needs, and a link to the existing page for each step. Step status is derived
 * from saved data; the owner's setup guidance only decides which workflows are
 * reminded about. Never required to use the workspace.
 */
export default async function SetupGuide({ params }: PageProps<"/staff/[tenant]/setup">) {
  const { tenant: slug } = await params;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const isOwner = membership.role === "owner";

  // The same saved-setup facts as the dashboard (staff only; suspended workspaces never get here).
  const { data, error } = await supabase.rpc("staff_dashboard", { p_tenant_id: tenant.id, p_upcoming_limit: UPCOMING_SHOWN });
  const parsed = dashboardSchema.safeParse(data);
  if (error || !parsed.success) {
    if (error?.code === "P0002") notFound();
    throw new Error("The setup guide couldn't be loaded.");
  }
  const count = { count: "exact", head: true } as const;
  const [settings, packages, gear, questions, contractTemplates, planningTemplates, events] = await Promise.all([
    supabase
      .from("tenants")
      .select("deposit_percent, booking_confirmation_policy, booking_policy_version, planning_lock_days, logo_storage_path, brand_colors, setup_guidance")
      .eq("id", tenant.id)
      .single(),
    supabase.from("packages").select("package_items(gear_items!package_items_gear_item_fk(active))").eq("tenant_id", tenant.id).eq("active", true),
    supabase.from("gear_items").select("id", count).eq("tenant_id", tenant.id).eq("active", true),
    supabase.from("logistics_questions").select("id", count).eq("tenant_id", tenant.id).eq("active", true),
    supabase.from("contract_templates").select("id", count).eq("tenant_id", tenant.id).eq("active", true),
    supabase.from("planning_templates").select("default_event_type").eq("tenant_id", tenant.id).is("archived_at", null),
    supabase.from("events").select("id", count).eq("tenant_id", tenant.id).is("archived_at", null),
  ]);
  if (settings.error || packages.error || gear.error || questions.error || contractTemplates.error || planningTemplates.error || events.error) {
    throw new Error("The setup guide couldn't be loaded.");
  }
  const typeLabel = new Map<string, string>(EVENT_TYPES);
  const s = { ...parsed.data.setup, offerable_packages: offerablePackages(packages.data) };
  const guidance = isSetupGuidance(settings.data.setup_guidance) ? settings.data.setup_guidance : "proposals_and_contracts";
  const reminded = GUIDANCE_WORKFLOWS[guidance];
  const chosen = GUIDANCE_OPTIONS.find((o) => o.value === guidance)!;
  const groups = setupGuide(
    s,
    {
      hasLogo: Boolean(settings.data.logo_storage_path),
      hasBrandColor: typeof (settings.data.brand_colors as Record<string, unknown> | null)?.primary === "string",
      depositPercent: settings.data.deposit_percent,
      bookingPolicy: settings.data.booking_confirmation_policy,
      bookingPolicyReviewed: settings.data.booking_policy_version > 0,
      activeGear: gear.count ?? 0,
      activeQuestions: questions.count ?? 0,
      activeContractTemplates: contractTemplates.count ?? 0,
      activePlanningTemplates: planningTemplates.data.length,
      planningDefaults: EVENT_TYPES.filter(([key]) => planningTemplates.data.some((t) => t.default_event_type === key)).map(([key]) => typeLabel.get(key)!),
      planningLockDays: settings.data.planning_lock_days,
      events: events.count ?? 0,
    },
    slug,
    guidance,
  );
  const ready = readiness(s);
  const proposalsReady = ready.proposals.length === 0;
  const contractsReady = ready.contracts.length === 0;
  const remindedReady = reminded.every((w) => ready[w].length === 0);
  const recommended = groups.flatMap((g) => g.tasks).some(quiet);
  const nextSteps = recommended ? "The recommended steps below are worth a look, but nothing is blocking you." : "Review or adjust any step below.";
  const [title, description] =
    reminded.length === 0
      ? [
          "Your setup guide",
          "You've chosen planning-only guidance, so your dashboard shows no setup reminders. Proposals and contracts stay available whenever you need them, and their steps are below.",
        ]
      : remindedReady
        ? proposalsReady && contractsReady
          ? ["You're ready to send proposals and contracts", `Everything ${tenant.display_name} needs to send proposals and contracts is saved. ${nextSteps}`]
          : ["You're ready to send contracts", `Everything ${tenant.display_name} needs to send contracts is saved. ${nextSteps}`]
        : ["Let's get your business ready", "Set up what your bookings need. Do the steps in any order and come back any time."];

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}`}>
            Go to dashboard
          </Link>
        }
      />

      <section id="guidance" aria-labelledby="guidance-heading" data-testid="setup-guidance" data-guidance={guidance} className="grid scroll-mt-20 gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="grid gap-1">
          <h2 id="guidance-heading" className="text-base font-semibold">Choose your setup guidance</h2>
          <p className="text-muted-foreground">
            This only changes which steps this guide and your dashboard remind you about. It doesn&apos;t turn off any feature or change how new
            events are created, and each proposal and contract is still checked before it&apos;s sent.
          </p>
        </div>
        {isOwner ? (
          <ActionForm action={saveSetupGuidance.bind(null, slug)} submitLabel="Save guidance" trackUnsaved>
            <fieldset className="grid gap-3">
              <legend className="sr-only">Setup guidance</legend>
              {GUIDANCE_OPTIONS.map((o) => (
                <label key={o.value} className="grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 md:min-h-0">
                  <input type="radio" name="setup_guidance" value={o.value} defaultChecked={o.value === guidance} className="mt-0.5 size-4 accent-primary" />
                  <span className="font-medium">{o.label}</span>
                  <span className="col-start-2 text-xs text-muted-foreground">{o.description}</span>
                </label>
              ))}
            </fieldset>
          </ActionForm>
        ) : (
          <div className="grid gap-0.5" data-testid="setup-guidance-current">
            <p>
              <span className="text-muted-foreground">Setup guidance: </span>
              <span className="font-medium">{chosen.label}</span>
            </p>
            <p className="text-xs text-muted-foreground">{chosen.description} Only the owner can change this.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="readiness-heading" data-testid="setup-readiness" className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
        <h2 id="readiness-heading" className="text-base font-semibold">What you can do now</h2>
        <dl className="grid gap-3 sm:grid-cols-3 sm:gap-x-6">
          {(
            [
              ["Proposals", ready.proposals, "proposals", "Ready to send. Your taxes and packages allow it."],
              ["Contracts", ready.contracts, "contracts", "Ready to send, with or without a proposal first."],
            ] as const
          ).map(([label, missing, key, readyText]) => (
            <div key={key} className="flex items-start gap-2" data-testid={`ready-${key}`} data-ready={missing.length === 0} data-reminded={reminded.includes(key)}>
              <ProgressGlyph state={missing.length === 0 ? "complete" : "not_started"} className="mt-0.5" />
              <div className="grid">
                <dt className="font-medium">
                  {label}
                  {reminded.includes(key) ? null : <span className="font-normal text-muted-foreground"> · Skipped</span>}
                </dt>
                <dd className="text-muted-foreground">{missing.length === 0 ? readyText : `Can't be sent yet. Still needs: ${missing.join(", ")}.`}</dd>
              </div>
            </div>
          ))}
          <div className="flex items-start gap-2" data-testid="ready-planning" data-ready="true">
            <ProgressGlyph state="complete" className="mt-0.5" />
            <div className="grid">
              <dt className="font-medium">Planning only</dt>
              <dd className="text-muted-foreground">Ready. Events booked elsewhere need no proposal or contract.</dd>
            </div>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Steps are checked against what&apos;s saved, not whether your terms or prices are right. Each proposal and contract is still
          checked when you preview and send it. Recommended and optional steps never block you, and skipped ones are only left out of reminders.
          {!isOwner ? " Steps marked “owner only” can only be completed by the business owner." : null}
        </p>
      </section>

      {groups.map((group) => {
        const steps = (
          <ol className="divide-y overflow-hidden rounded-xl border bg-card">
            {group.tasks.map((t) => <TaskRow key={t.key} t={t} isOwner={isOwner} />)}
          </ol>
        );
        return (
          <section key={group.key} aria-labelledby={`setup-${group.key}-heading`} data-testid={`setup-group-${group.key}`} data-skipped={group.skipped} className="grid gap-2">
            <div className="grid gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h2 id={`setup-${group.key}-heading`} className="text-base font-semibold">{group.title}</h2>
                {group.skipped ? (
                  <span className="inline-flex items-center gap-1.5 self-center text-xs font-medium text-muted-foreground" data-testid="setup-group-status">
                    <ProgressGlyph state="not_applicable" />
                    Skipped
                  </span>
                ) : null}
              </div>
              {group.description ? <p className="text-sm text-muted-foreground">{group.description}</p> : null}
              {group.skipped ? (
                <p className="text-sm text-muted-foreground">
                  Left out of your reminders by your setup guidance. Each step still shows what&apos;s saved.
                  {isOwner ? null : " Only the owner can change this."}
                </p>
              ) : null}
              {group.skipped && isOwner ? (
                // A real 44px box on phones (not tap-target-y), so it never reaches into the summary below.
                <a className="inline-flex min-h-11 items-center justify-self-start text-sm font-medium underline underline-offset-4 lg:min-h-0" href="#guidance">
                  Change your setup guidance
                </a>
              ) : null}
            </div>
            {group.skipped ? (
              <details className="group/steps">
                <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg pr-2 text-sm font-medium outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/steps:rotate-90" />
                  Show {group.title.toLowerCase()} steps
                </summary>
                <div className="pt-2">{steps}</div>
              </details>
            ) : (
              steps
            )}
          </section>
        );
      })}
    </>
  );
}
