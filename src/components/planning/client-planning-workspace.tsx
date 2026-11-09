"use client";

import type { ComponentProps, ReactNode } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { CLIENT_PAGE_LOGO } from "@/lib/branding/logo-size";
import { customQuestionsByItem } from "@/lib/planning/custom-questions";
import { savedListsFrom } from "@/lib/planning/music";
import { PROVIDED_SECTION, WORKSPACE_ID, headingId, languageAskedInPreferences, planSections } from "@/lib/planning/navigation";
import type { StageEditor } from "@/lib/planning/stages";
import { formatEventDate, savedAnswersByItem, type ClientPlanningView, type PlanProgress, type SaveItemResult } from "@/lib/planning/view";
import { AnswerPreviewProvider } from "./answer-preview";
import { BasicsEditor } from "./basics-editor";
import { EditingChip, PlanOverview } from "./client-planning";
import { GrandEntranceGate, GrandEntranceProvider } from "./grand-entrance";
import { ceremonyDetails, generalEditor, grandEntranceState, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "./moment-editor";
import { MusicListsProvider } from "./music-editor";
import { PanelHeading, PlanMoment, PlanNavigation, PlanPanel, PlanSidebar, SectionHeader, SectionPager, SectionPicker, UnsavedElsewhere } from "./plan-navigation";
import { AlreadyProvided } from "./plan-overview";
import { EditingNotice, ItemStatus, PlanProgressProvider } from "./progress";
import { SaveRegistryProvider, SaveScope } from "./save-registry";
import { StageDetailsEditor } from "./stage-details-editor";

export type AvailableClientPlanningView = Extract<ClientPlanningView, { state: "available" }>;
type SaveAction = (itemId: string, expectedRevision: number, answers: unknown) => Promise<SaveItemResult>;

/** Progress with nothing counted: what a preview hands the shared progress state (it never shows it). */
export const PREVIEW_PROGRESS: PlanProgress = {
  scope: "available_sections_only",
  items: [],
  requirements_total: 0,
  requirements_met: 0,
  percent: null,
  available_sections: 0,
  complete_sections: 0,
  unavailable_sections: 0,
};

/**
 * A save that never leaves the browser, for previews: it accepts what was typed as if the database had
 * (the editors' own checks still run), so conditional fields and lists behave as for the client, and
 * nothing is sent, stored or counted. Progress stays empty; previews don't show it.
 */
function previewSave(): (itemId: string) => (expectedRevision: number, answers: unknown) => Promise<SaveItemResult> {
  return () => async (expectedRevision, answers) => ({
    status: "saved",
    revision: expectedRevision + 1,
    answers: (answers ?? {}) as Record<string, unknown>,
    progress: PREVIEW_PROGRESS,
    timeline_warnings: [],
  });
}

/**
 * The client's planning workspace: header, overview, navigation and every section with its editors.
 * One implementation for the client's own page and for staff previews (a template's sample event, or an
 * event's plan "as the client sees it"), so a preview can never drift from what clients get.
 *
 * - Client page: `saveAction` is the client save Server Action (bound to the business and event); the
 *   database decides access, deadlines and validation on every save.
 * - Preview: no `saveAction`. Saves stay in the browser (previewSave), progress is hidden, and the
 *   `preview` note says so. No Server Action or database function is called from the editors.
 */
export function ClientPlanningWorkspace({ view, logo, saveAction, preview }: {
  view: AvailableClientPlanningView;
  logo: ComponentProps<typeof BrandLogo>["logo"];
  saveAction?: SaveAction;
  /** Preview mode: what to say above the plan (nothing is saved, whose plan it is). */
  preview?: ReactNode;
}) {
  const isPreview = preview !== undefined || !saveAction;
  const dj = view.brand.display_name;
  const djDisplayName = view.dj_name ?? null;
  const sections = planSections(view.structure);
  const stageCount = sections.filter((s) => s.kind === "stage").length;
  const providedCount = view.imported?.questions.length ?? 0;
  const event = { date: view.event.event_date, timezone: view.event.timezone, venueName: view.event.venue_name, venueAddress: view.event.venue_address };
  const save = isPreview || !saveAction ? previewSave() : (itemId: string) => (expectedRevision: number, answers: unknown) => saveAction(itemId, expectedRevision, answers);
  const general = new Map(view.structure.general.map((g) => [g.id, g]));
  const moments = new Map(view.structure.stages.flatMap((s) => s.moments).map((m) => [m.id, m]));
  const known = knownPeople(view.structure.stages, view.moments, view.stage_details);
  const ceremony = ceremonyDetails(view.structure.stages, view.stage_details);
  // One sheet per section on the planning canvas: edge to edge on phones, where the sticky
  // Previous/Next bar closes it (no bottom padding; the bar carries the sheet's padding).
  const card =
    "grid min-w-0 grid-cols-1 gap-6 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6 max-lg:pb-0 [--plan-sheet-pad:1rem] sm:[--plan-sheet-pad:1.5rem]";

  return (
    <PlanProgressProvider
      initial={isPreview ? PREVIEW_PROGRESS : view.progress}
      warnings={isPreview ? [] : view.timeline_warnings}
      basics={view.basics.answers}
      editing={view.editing}
      preview={isPreview}
    >
      <SaveRegistryProvider>
        <AnswerPreviewProvider
          context={{ djName: dj, djDisplayName, venueName: view.event.venue_name, eventContacts: view.event_contacts, customQuestions: customQuestionsByItem(view.structure) }}
          saved={savedAnswersByItem(view)}
        >
          <header className="grid gap-4">
            {preview}
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-h-8 min-w-0 items-center text-sm">
                <BrandLogo logo={logo} name={dj} className={CLIENT_PAGE_LOGO} fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
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
                            generalEditor(g, { moments: view.moments, eventContacts: view.event_contacts, known, djName: dj, djDisplayName, audience: "client", event, save })
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
  );
}
