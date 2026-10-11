import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, CheckCircle2, Circle, CircleDashed } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/app/fields";
import { requireStaff } from "@/lib/auth/staff";
import { UPCOMING_SHOWN, dashboardSchema } from "@/lib/dashboard";
import { STATUS_LABEL, fromSetup, offerablePackages, readiness, setupGuide, type SetupStatus } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { EVENT_TYPES } from "../events/event-form";

const STATUS_STYLE: Record<SetupStatus, string> = {
  ready: "text-emerald-700 dark:text-emerald-400",
  attention: "text-amber-800 dark:text-amber-300",
  not_started: "text-foreground",
  optional: "text-muted-foreground",
};

function StatusIcon({ status }: { status: SetupStatus }) {
  const cls = "mt-0.5 size-5 shrink-0";
  if (status === "ready") return <CheckCircle2 aria-hidden className={cn(cls, "text-emerald-600")} />;
  if (status === "attention") return <AlertCircle aria-hidden className={cn(cls, "text-amber-600")} />;
  if (status === "optional") return <CircleDashed aria-hidden className={cn(cls, "text-muted-foreground")} />;
  return <Circle aria-hidden className={cn(cls, "text-muted-foreground")} />;
}

/**
 * The setup guide: what this business has saved, what each workflow still
 * needs, and a link to the existing page for each step. Read-only and derived
 * from saved data (no onboarding state); never required to use the workspace.
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
      .select("deposit_percent, booking_confirmation_policy, booking_policy_version, planning_lock_days, logo_storage_path, brand_colors")
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
  );
  const ready = readiness(s);
  const allRequired = ready.readyCount === ready.total;

  return (
    <>
      <PageHeader
        title={allRequired ? "Your business is set up" : "Let's get your business ready"}
        description={
          allRequired
            ? `Everything ${tenant.display_name} needs to send proposals and contracts is saved. Review or adjust any step below.`
            : "Set up the essentials so you can start sending proposals and planning events. Do the steps in any order and come back any time."
        }
        actions={
          <Link className={buttonVariants({ variant: "outline" })} href={`/staff/${slug}`}>
            Go to dashboard
          </Link>
        }
      />

      <section aria-labelledby="readiness-heading" data-testid="setup-readiness" className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="readiness-heading" className="text-base font-semibold">What you can do now</h2>
          <span className="text-muted-foreground" data-testid="setup-progress">
            {ready.readyCount} of {ready.total} required steps ready
          </span>
        </div>
        <dl className="grid gap-2 sm:grid-cols-2 sm:gap-x-6">
          {(
            [
              ["Proposals", ready.proposals, "proposals", "Your taxes and packages allow sending proposals."],
              ["Contracts", ready.contracts, "contracts", "Your business details and contract template allow sending a contract once a proposal is approved."],
            ] as const
          ).map(([label, missing, key, readyText]) => (
            <div key={key} className="flex items-start gap-2" data-testid={`ready-${key}`} data-ready={missing.length === 0}>
              <StatusIcon status={missing.length === 0 ? "ready" : "not_started"} />
              <div className="grid">
                <dt className="font-medium">{label}</dt>
                <dd className="text-muted-foreground">{missing.length === 0 ? readyText : `Can't be sent yet. Still needs: ${missing.join(", ")}.`}</dd>
              </div>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Steps are checked against what&apos;s saved, not whether your terms or prices are right. Each proposal and contract is still
          checked when you preview and send it. Optional steps never block you.
          {!isOwner ? " Steps marked “owner only” can only be completed by the business owner." : null}
        </p>
      </section>

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`setup-${group.key}-heading`} className="grid gap-2">
          <h2 id={`setup-${group.key}-heading`} className="text-base font-semibold">{group.title}</h2>
          <ol className="divide-y overflow-hidden rounded-xl border bg-card">
            {group.tasks.map((t) => (
              <li key={t.key} data-testid={`setup-task-${t.key}`} data-status={t.status} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <StatusIcon status={t.status} />
                  <div className="grid min-w-0 gap-1 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <h3 className="font-medium">{t.label}</h3>
                      <span className={cn("text-xs font-medium", STATUS_STYLE[t.status])} data-testid="setup-status">{STATUS_LABEL[t.status]}</span>
                    </div>
                    <p className="text-muted-foreground">{t.description}</p>
                    <p className="text-xs">
                      <span className="text-muted-foreground">{t.needed}{t.ownerOnly ? " · Owner only" : ""}.</span> {t.hint}
                    </p>
                  </div>
                </div>
                <Link
                  className={cn(buttonVariants({ variant: t.done ? "ghost" : "outline", size: "sm" }), "ml-8 sm:ml-0")}
                  href={fromSetup(t.href)}
                  aria-label={`${t.done || (t.ownerOnly && !isOwner) ? "View" : t.action}: ${t.label}`}
                >
                  {t.done || (t.ownerOnly && !isOwner) ? "View" : t.action}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
