import type { Metadata } from "next";
import Link from "next/link";
import { loginHref } from "@/lib/auth/redirects";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { ClientPlanningWorkspace } from "@/components/planning/client-planning-workspace";
import { ClientFooter } from "@/components/app/client-footer";
import { ClientHeader } from "@/components/app/client-header";
import { signOut } from "@/app/auth/confirm/actions";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { clientPlanningViewSchema, formatEventDate } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";
import { saveClientItemAction } from "./actions";
import { brandStyle } from "@/lib/branding/colors";
import { eventHubPath } from "@/lib/client-event";
import { liveBrand } from "@/lib/branding/logo.server";

export const metadata: Metadata = { title: "Event planning", robots: { index: false, follow: false }, referrer: "strict-origin" };

function Notice({ title, email, children }: { title: string; email: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <ClientHeader email={email} back={email !== null} signOut={email ? signOut : undefined} />
      <main className="mx-auto grid w-full max-w-md px-4 py-12">
        <div className="grid gap-3 rounded-2xl border bg-card p-6 text-sm shadow-sm">
          <Lock aria-hidden className="size-7 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{title}</h1>
          {children}
        </div>
      </main>
      <ClientFooter />
    </div>
  );
}

/**
 * The client's planning: an overview, then one section at a time (general
 * sections, then the stages in the plan's order). Every request is checked in
 * the database: verified identity, access to this exact event, a booked event,
 * and nothing archived. Only client-safe fields are returned. After the
 * planning deadline (unless the DJ reopened it) the page is read-only; the
 * database refuses client saves regardless of what this page shows, so a
 * stale or cached copy can never write.
 *
 * Every section is rendered and stays mounted; only the open one is shown
 * (see PlanNavigation), so moving between sections never drops input.
 */
export default async function ClientPlanningPage({ params }: PageProps<"/[tenant]/planning/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(eventId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <Notice title="Sign in to plan your event" email={null}>
        <p>Your planning is private. <Link className="underline" href={loginHref("client", `/${slug}/planning/${eventId}`)}>Sign in with your email</Link> to open it.</p>
      </Notice>
    );
  }
  const email = auth.user.email ?? "";
  const { data } = await supabase.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: slug });
  const parsed = clientPlanningViewSchema.safeParse(data);
  const view = parsed.success ? parsed.data : { state: "unavailable" as const };
  if (view.state === "setting_up") {
    return (
      // Booked, but the DJ hasn't opened planning yet (database state "setting_up"): a bookmark or an old link lands here.
      <Notice title="Your DJ is getting your planning ready" email={email}>
        <p data-testid="planning-setting-up">
          {view.brand.display_name} is preparing the planning for {view.event.title} ({formatEventDate(view.event.event_date)}). It will open
          soon, and they&apos;ll let you know when it&apos;s time to get started. Your booking details are on{" "}
          <Link className="underline" href={eventHubPath(slug, eventId)}>your event page</Link>.
        </p>
      </Notice>
    );
  }
  if (view.state !== "available") {
    return (
      <Notice title="Planning isn't available" email={email}>
        {/* One message for every reason (not booked yet, archived, another account): the reason is never revealed. */}
        <p>
          This event&apos;s planning can&apos;t be opened from this account right now. It may not be ready yet, or the event may no longer be
          active. If you think it should be available, contact your DJ. See{" "}
          <Link className="underline" href="/my">your events</Link>.
        </p>
      </Notice>
    );
  }

  const pageStyle = brandStyle(view.brand.brand_colors.primary);
  const brandLogo = (await liveBrand(slug))?.logo ?? null;

  return (
    // Closed when the page loaded: answers read as a review, not as disabled forms (globals.css). A plan
    // that closes while open keeps its editors on screen, unsaved input marked as such.
    <div data-plan-shell data-plan-readonly={view.editing?.state === "closed" ? "" : undefined} className="flex min-h-dvh flex-col bg-plan-canvas">
      <ClientHeader email={email} back={{ href: eventHubPath(slug, eventId), label: "Your event" }} title="Your planning" wide signOut={signOut} />
      <main style={pageStyle} className="mx-auto grid w-full max-w-5xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-8 sm:pt-8">
        {/* The same workspace staff previews use; every save goes through the client save action (checked in the database). */}
        <ClientPlanningWorkspace view={view} logo={brandLogo} saveAction={saveClientItemAction.bind(null, slug, eventId)} />
      </main>
      <ClientFooter wide />
    </div>
  );
}
