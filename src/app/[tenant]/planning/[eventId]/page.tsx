import type { Metadata } from "next";
import Link from "next/link";
import { loginHref } from "@/lib/auth/redirects";
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
import { ceremonyDetails, generalEditor, grandEntranceState, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "@/components/planning/moment-editor";
import { GrandEntranceGate, GrandEntranceProvider } from "@/components/planning/grand-entrance";
import { MusicListsProvider } from "@/components/planning/music-editor";
import { EditingNotice, ItemStatus, PlanProgressProvider } from "@/components/planning/progress";
import { SaveRegistryProvider, SaveScope } from "@/components/planning/save-registry";
import { AnswerPreviewProvider } from "@/components/planning/answer-preview";
import { StageDetailsEditor } from "@/components/planning/stage-details-editor";
import { ClientFooter } from "@/components/app/client-footer";
import { ClientHeader } from "@/components/app/client-header";
import { signOut } from "@/app/auth/confirm/actions";
import { savedListsFrom } from "@/lib/planning/music";
import { PROVIDED_SECTION, WORKSPACE_ID, headingId, languageAskedInPreferences, planSections } from "@/lib/planning/navigation";
import type { StageEditor } from "@/lib/planning/stages";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { clientPlanningViewSchema, formatEventDate, savedAnswersByItem } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";
import { saveClientItemAction } from "./actions";
import { BrandLogo } from "@/components/app/brand-logo";
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
      <Notice title="Your DJ is setting up your event planning" email={email}>
        <p data-testid="planning-setting-up">
          Check back soon. {view.brand.display_name} is preparing the planning for {view.event.title} ({formatEventDate(view.event.event_date)}).
          You&apos;ll be able to fill it in once it&apos;s ready. See <Link className="underline" href="/my">your events</Link>.
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

  const dj = view.brand.display_name;
  const djDisplayName = view.dj_name ?? null;
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
  // One sheet per section on the planning canvas: edge to edge on phones, where the sticky
  // Previous/Next bar closes it (no bottom padding; the bar carries the sheet's padding).
  const card =
    "grid min-w-0 grid-cols-1 gap-6 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6 max-lg:pb-0 [--plan-sheet-pad:1rem] sm:[--plan-sheet-pad:1.5rem]";

  return (
    // Closed when the page loaded: answers read as a review, not as disabled forms (globals.css). A plan
    // that closes while open keeps its editors on screen, unsaved input marked as such.
    <div data-plan-shell data-plan-readonly={view.editing?.state === "closed" ? "" : undefined} className="flex min-h-dvh flex-col bg-plan-canvas">
      <ClientHeader email={email} back={{ href: eventHubPath(slug, eventId), label: "Your event" }} title="Your planning" wide signOut={signOut} />
      <main style={pageStyle} className="mx-auto grid w-full max-w-5xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-8 sm:pt-8">
        <PlanProgressProvider initial={view.progress} warnings={view.timeline_warnings} basics={view.basics.answers} editing={view.editing}>
          <SaveRegistryProvider>
            <AnswerPreviewProvider
              context={{ djName: dj, djDisplayName, venueName: view.event.venue_name, eventContacts: view.event_contacts }}
              saved={savedAnswersByItem(view)}
            >
              <header className="grid gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-h-8 min-w-0 items-center text-sm">
                    <BrandLogo logo={brandLogo} name={dj} className="max-h-9 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
                  </span>
                  <EditingChip />
                </div>
                <div className="grid gap-1.5">
                  <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight text-balance [overflow-wrap:anywhere] sm:text-[1.75rem]">{view.event.title}</h1>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-plan-ink-2">
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
                </div>
                <EditingNotice djName={dj} />
              </header>

              <PlanNavigation sections={sections} extras={providedCount > 0 ? [{ key: PROVIDED_SECTION, label: "Already provided" }] : []}>
                {/* The sidebar steps aside on the overview (its rows lead to every section); the grid follows it. */}
                <div id={WORKSPACE_ID} className="grid scroll-mt-4 gap-4 lg:items-start lg:gap-8 lg:has-[>[data-plan-sidebar]]:grid-cols-[15rem_minmax(0,1fr)]">
                  <PlanSidebar hideOnOverview />
                  <div className="grid min-w-0 gap-4">
                    <SectionPicker />
                    <UnsavedElsewhere />
                    <MusicListsProvider
                      initial={savedListsFrom(view.structure.stages, view.music)}
                      introductions={savedIntroductions(view.structure.stages, view.moments)}
                      processionalPeople={savedProcessionalPeople(view.structure.stages, view.moments)}
                    >
                      <GrandEntranceProvider state={grandEntranceState(view.structure.stages, view.stage_details, view.moments, view.music)}>
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
                                  languageInPreferences={languageAskedInPreferences(view.structure)}
                                />
                              ) : (
                                generalEditor(g, { moments: view.moments, eventContacts: view.event_contacts, known, djName: dj, djDisplayName, audience: "client", save })
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
                                <SectionHeader sectionKey={s.key} eyebrow={stageCount === 1 ? "Your event" : `Part ${stageNumber} of ${stageCount}`} />
                                {s.stageEditor ? (
                                  <section data-plan-item={s.id} tabIndex={-1} aria-labelledby={`details-heading-${s.key}`} className="grid gap-3 text-sm outline-none">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <h3 id={`details-heading-${s.key}`} className="text-base leading-snug font-semibold [overflow-wrap:anywhere]">
                                        {s.detailsLabel ?? `${s.label} details`}
                                      </h3>
                                      <span data-testid="details-status"><ItemStatus itemId={s.id} /></span>
                                    </div>
                                    <SaveScope item={s.id}>
                                      <StageDetailsEditor
                                        itemId={s.id}
                                        stageKey={s.key}
                                        stageLabel={s.label}
                                        title={s.detailsLabel ?? `${s.label} details`}
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
                                  <div className="grid gap-3">
                                    {single ? null : <h3 className="text-base leading-snug font-semibold">In this part of the event</h3>}
                                    <ul className="-mx-[var(--plan-sheet-pad,0px)] divide-y divide-plan-hairline border-y border-plan-hairline" aria-label={`Moments in ${s.label}`}>
                                      {s.moments.map((m) => (
                                        <GrandEntranceGate key={m.id} momentKey={m.key}>
                                          <PlanMoment moment={m} defaultOpen={single}>
                                            {momentEditor(moments.get(m.id)!, { music: view.music, moments: view.moments, djName: dj, djDisplayName, audience: "client", event, ceremony, save })}
                                          </PlanMoment>
                                        </GrandEntranceGate>
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
                      </GrandEntranceProvider>
                    </MusicListsProvider>
                  </div>
                </div>
              </PlanNavigation>
            </AnswerPreviewProvider>
          </SaveRegistryProvider>
        </PlanProgressProvider>
      </main>
      <ClientFooter wide />
    </div>
  );
}
