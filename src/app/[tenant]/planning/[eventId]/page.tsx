import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Lock, MapPin } from "lucide-react";
import { BasicsEditor } from "@/components/planning/basics-editor";
import { EditingChip, PlanOverview } from "@/components/planning/client-planning";
import {
  PanelHeading,
  PlanMoment,
  PlanNavigation,
  PlanPanel,
  PlanSidebar,
  SectionHeader,
  SectionPager,
  SectionPicker,
  UnsavedElsewhere,
} from "@/components/planning/plan-navigation";
import { AlreadyProvided } from "@/components/planning/plan-overview";
import { ceremonyDetails, generalEditor, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "@/components/planning/moment-editor";
import { MusicListsProvider } from "@/components/planning/music-editor";
import { EditingNotice, ItemStatus, PlanProgressProvider } from "@/components/planning/progress";
import { SaveRegistryProvider, SaveScope } from "@/components/planning/save-registry";
import { StageDetailsEditor } from "@/components/planning/stage-details-editor";
import { ClientHeader } from "@/components/app/client-header";
import { signOut } from "@/app/auth/confirm/actions";
import { savedListsFrom } from "@/lib/planning/music";
import { PROVIDED_SECTION, WORKSPACE_ID, headingId, planSections } from "@/lib/planning/navigation";
import type { StageEditor } from "@/lib/planning/stages";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { clientPlanningViewSchema, formatEventDate } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";
import { saveClientItemAction } from "./actions";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";

export const metadata: Metadata = { title: "Event planning", robots: { index: false, follow: false }, referrer: "strict-origin" };

function Notice({ title, email, children }: { title: string; email: string | null; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-muted/40">
      <ClientHeader email={email} back={email !== null} signOut={email ? signOut : undefined} />
      <main className="mx-auto grid w-full max-w-md px-4 py-12">
        <div className="grid gap-3 rounded-2xl border bg-card p-6 text-sm shadow-sm">
          <Lock aria-hidden className="size-7 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{title}</h1>
          {children}
        </div>
      </main>
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
        <p>Your planning is private. <Link className="underline" href="/login">Sign in with your email</Link> to open it.</p>
      </Notice>
    );
  }
  const email = auth.user.email ?? "";
  const { data } = await supabase.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: slug });
  const parsed = clientPlanningViewSchema.safeParse(data);
  const view = parsed.success ? parsed.data : { state: "unavailable" as const };
  if (view.state !== "available") {
    return (
      <Notice title="Planning isn't available" email={email}>
        <p>
          Planning opens once your booking is confirmed. If it was, this account may not have access to this event. See{" "}
          <Link className="underline" href="/my">your events</Link>.
        </p>
      </Notice>
    );
  }

  const dj = view.brand.display_name;
  const pageStyle = brandStyle(view.brand.brand_colors.primary);
  const brandLogo = (await liveBrand(slug))?.logo ?? null;
  const sections = planSections(view.structure);
  const stageCount = sections.filter((s) => s.kind === "stage").length;
  const providedCount = view.imported?.questions.length ?? 0;
  const event = { date: view.event.event_date, timezone: view.event.timezone, venueName: view.event.venue_name, venueAddress: view.event.venue_address };
  const save = (itemId: string) => saveClientItemAction.bind(null, slug, eventId, itemId);
  const general = new Map(view.structure.general.map((g) => [g.id, g]));
  const moments = new Map(view.structure.stages.flatMap((s) => s.moments).map((m) => [m.id, m]));
  const known = knownPeople(view.structure.stages, view.moments, view.stage_details);
  const ceremony = ceremonyDetails(view.structure.stages, view.stage_details);
  const card = "grid min-w-0 gap-5 rounded-2xl border bg-card p-4 shadow-sm sm:p-6";

  return (
    <div className="min-h-dvh bg-muted/40">
      <ClientHeader email={email} back wide signOut={signOut} />
      <main style={pageStyle} className="mx-auto grid w-full max-w-5xl gap-4 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:pt-8">
        <PlanProgressProvider initial={view.progress} warnings={view.timeline_warnings} basics={view.basics.answers} editing={view.editing}>
          <SaveRegistryProvider>
            <header className="overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div aria-hidden className="h-1.5 bg-[var(--brand)]" />
              <div className="grid gap-3 p-4 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-h-8 min-w-0 items-center text-sm">
                    <BrandLogo logo={brandLogo} name={dj} className="max-h-10 max-w-40" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
                  </span>
                  <EditingChip />
                </div>
                <div className="grid gap-1">
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Event planning</p>
                  <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{view.event.title}</h1>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays aria-hidden className="size-4 shrink-0" />
                      {formatEventDate(view.event.event_date)}
                    </span>
                    {view.event.venue_name ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
                        <MapPin aria-hidden className="size-4 shrink-0" />
                        {view.event.venue_name}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">Date and venue are set by {dj}. Contact them to change either.</p>
                </div>
              </div>
            </header>

            <EditingNotice djName={dj} />

            <PlanNavigation sections={sections} extras={providedCount > 0 ? [{ key: PROVIDED_SECTION, label: "Already provided" }] : []}>
              <div id={WORKSPACE_ID} className="grid scroll-mt-4 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
                <PlanSidebar />
                <div className="grid min-w-0 gap-4">
                  <SectionPicker />
                  <UnsavedElsewhere />
                  <MusicListsProvider
                    initial={savedListsFrom(view.structure.stages, view.music)}
                    introductions={savedIntroductions(view.structure.stages, view.moments)}
                    processionalPeople={savedProcessionalPeople(view.structure.stages, view.moments)}
                  >
                    <PlanPanel view={null} testId="plan-overview">
                      <PlanOverview djName={dj} providedCount={providedCount} />
                    </PlanPanel>

                    {sections.map((s, index) => {
                      if (s.kind === "general") {
                        const g = general.get(s.id)!;
                        const editor =
                          g.key === "basics" ? (
                            <BasicsEditor
                              itemId={view.basics.item_id}
                              initialAnswers={view.basics.answers}
                              initialRevision={view.basics.revision}
                              eventVenue={{ name: view.event.venue_name, address: view.event.venue_address }}
                              djName={dj}
                              audience="client"
                              save={save(view.basics.item_id)}
                            />
                          ) : (
                            generalEditor(g, { moments: view.moments, eventContacts: view.event_contacts, known, djName: dj, audience: "client", save })
                          );
                        return (
                          <PlanPanel key={s.key} view={s.key} testId={`section-${s.key}`}>
                            <section aria-labelledby={headingId(s.key)} className={card}>
                              <SectionHeader sectionKey={s.key} eyebrow="Event details" />
                              <div data-plan-item={s.id} tabIndex={-1} className="grid gap-3 text-sm outline-none">
                                <SaveScope item={s.id}>{editor}</SaveScope>
                              </div>
                              <SectionPager view={s.key} />
                            </section>
                          </PlanPanel>
                        );
                      }
                      const stageNumber = index - (sections.length - stageCount) + 1;
                      const single = !s.stageEditor && s.moments.length === 1;
                      return (
                        <PlanPanel key={s.key} view={s.key} testId={`stage-${s.key}`}>
                          <section aria-labelledby={headingId(s.key)} className={card}>
                            <SectionHeader sectionKey={s.key} eyebrow={`Part ${stageNumber} of ${stageCount} of your event`} />
                            {s.stageEditor ? (
                              <section data-plan-item={s.id} tabIndex={-1} aria-labelledby={`details-heading-${s.key}`} className="grid gap-3 text-sm outline-none">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <h3 id={`details-heading-${s.key}`} className="text-base font-semibold [overflow-wrap:anywhere]">
                                    {s.detailsLabel ?? `${s.label} details`}
                                  </h3>
                                  <span data-testid="details-status"><ItemStatus itemId={s.id} /></span>
                                </div>
                                <SaveScope item={s.id}>
                                  <StageDetailsEditor
                                    itemId={s.id}
                                    stageKey={s.key}
                                    stageLabel={s.label}
                                    editor={s.stageEditor as StageEditor}
                                    initialAnswers={view.stage_details[s.id]?.answers ?? {}}
                                    initialRevision={view.stage_details[s.id]?.revision ?? 0}
                                    event={event}
                                    djName={dj}
                                    audience="client"
                                    save={save(s.id)}
                                  />
                                </SaveScope>
                              </section>
                            ) : null}
                            {s.moments.length > 0 ? (
                              <div className="grid gap-2">
                                {single ? null : (
                                  <div className="grid gap-0.5">
                                    <h3 className="text-base font-semibold">In this part of the event</h3>
                                    <p className="text-xs text-muted-foreground">Open each one to fill it in. They stay in the order of your event.</p>
                                  </div>
                                )}
                                <ul className="grid gap-2" aria-label={`Moments in ${s.label}`}>
                                  {s.moments.map((m) => (
                                    <li key={m.id}>
                                      <PlanMoment moment={m} defaultOpen={single}>
                                        {momentEditor(moments.get(m.id)!, { music: view.music, moments: view.moments, djName: dj, audience: "client", event, ceremony, save })}
                                      </PlanMoment>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                            {s.covered.map((c) => (
                              <p key={c.label} className="text-xs text-muted-foreground">
                                {c.label}: {c.by ? `Included in ${c.by}` : "Included in another part of your plan"}.
                              </p>
                            ))}
                            {s.unavailable.length > 0 ? (
                              <p className="text-xs text-muted-foreground">
                                Not open for planning yet, and not counted in progress: {s.unavailable.join(", ")}.
                              </p>
                            ) : null}
                            <SectionPager view={s.key} />
                          </section>
                        </PlanPanel>
                      );
                    })}

                    {providedCount > 0 ? (
                      <PlanPanel view={PROVIDED_SECTION} testId="already-provided">
                        <section aria-labelledby={headingId(PROVIDED_SECTION)} className={card}>
                          <PanelHeading view={PROVIDED_SECTION}>Already provided</PanelHeading>
                          <AlreadyProvided imported={view.imported} djName={dj} audience="client" />
                          <SectionPager view={PROVIDED_SECTION} />
                        </section>
                      </PlanPanel>
                    ) : null}
                  </MusicListsProvider>
                </div>
              </div>
            </PlanNavigation>
          </SaveRegistryProvider>
        </PlanProgressProvider>
      </main>
    </div>
  );
}
