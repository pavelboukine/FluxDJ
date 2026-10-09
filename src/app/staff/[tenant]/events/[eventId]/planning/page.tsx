import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, ClipboardList, MapPin, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { CheckboxField, PageHeader, SelectField } from "@/components/app/fields";
import { BasicsEditor } from "@/components/planning/basics-editor";
import { ceremonyDetails, generalEditor, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "@/components/planning/moment-editor";
import { MusicListsProvider } from "@/components/planning/music-editor";
import { AlreadyProvided } from "@/components/planning/plan-overview";
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
import { ItemStatus, PlanProgressProvider } from "@/components/planning/progress";
import { SaveRegistryProvider, SaveScope } from "@/components/planning/save-registry";
import { StaffPlanOverview } from "@/components/planning/staff-planning";
import { StageDetailsEditor } from "@/components/planning/stage-details-editor";
import { StructureEditor } from "@/components/planning/structure-editor";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { savedListsFrom } from "@/lib/planning/music";
import { CLIENT_EDITING_SECTION, PROVIDED_SECTION, STRUCTURE_SECTION, WORKSPACE_ID, headingId, planSections } from "@/lib/planning/navigation";
import type { StageEditor } from "@/lib/planning/stages";
import { formatEventDate, staffPlanningViewSchema } from "@/lib/planning/view";
import { EVENT_TYPES } from "../../event-form";
import { addPlanItem, applyPlanningTemplate, planItemAction, saveStaffItemAction, setUpPlanning } from "./actions";
import { ClientEditingCard } from "./client-editing-card";
import { EditingControl } from "./editing-control";

/**
 * Staff planning for one event: an overview (progress, what needs
 * attention, the client and the plan), the client-editing control, then one
 * section at a time with the same navigation, editors and autosave as the
 * client's page. Every section stays mounted (inactive ones are hidden), so
 * switching never drops input. Deadline, proposal answers and structure are
 * views of their own. Staff edit regardless of the client deadline; archived
 * events are read-only.
 */
export default async function StaffPlanningPage({ params }: PageProps<"/staff/[tenant]/events/[eventId]/planning">) {
  const { tenant: slug, eventId } = await params;
  if (!UUID_RE.test(eventId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: event } = await supabase
    .from("events")
    .select("id, title, event_type, event_date, timezone, venue_name, venue_address, lifecycle_status, booking_confirmed_at, archived_at, event_clients(is_primary, clients(name, email, phone, archived_at))")
    .eq("id", eventId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!event) notFound();
  const [{ data: viewData }, { data: templates }, { data: library }] = await Promise.all([
    supabase.rpc("staff_planning_view", { p_event_id: event.id }),
    supabase.from("planning_templates").select("id, name, default_event_type").eq("tenant_id", tenant.id).is("archived_at", null).order("name"),
    supabase.rpc("planning_library"),
  ]);
  const view = staffPlanningViewSchema.parse(viewData);
  const typeLabel = new Map<string, string>(EVENT_TYPES).get(event.event_type) ?? event.event_type;
  const defaultTemplate = (templates ?? []).find((t) => t.default_event_type === event.event_type);
  const templateOptions = (templates ?? []).map((t) => ({ value: t.id, label: t.name }));
  const archived = Boolean(event.archived_at);
  const lockedReason = archived ? "Unarchive the event to edit planning." : undefined;
  const booked = Boolean(event.booking_confirmed_at) && (event.lifecycle_status === "booked" || event.lifecycle_status === "completed");
  const base = `/staff/${slug}/events/${event.id}`;
  const clients = (event.event_clients ?? [])
    .flatMap((ec) => (ec.clients && !ec.clients.archived_at ? [{ ...ec.clients, primary: ec.is_primary }] : []))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const dj = tenant.display_name;
  const link = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <>
      <PageHeader
        title={event.title}
        description={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden className="size-4" />{formatEventDate(event.event_date)}</span>
            <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
              <MapPin aria-hidden className="size-4 shrink-0" />{event.venue_name ?? "Venue not entered"}
            </span>
            <span>{typeLabel} · Planning</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {archived ? <Badge variant="secondary">Archived</Badge> : null}
            <Link className={link} href={base}>Event</Link>
            {view.plan !== null ? (
              <Link className={`${link} border-primary bg-primary text-primary-foreground hover:bg-primary/90`} href={`${base}/run-sheet`}>
                <ClipboardList aria-hidden className="size-4" />Run sheet
              </Link>
            ) : null}
          </div>
        }
      />
      {archived ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This event is archived. The client can&apos;t open or change planning, and planning can&apos;t be changed here until you unarchive
          the event. Saved answers are kept.
        </p>
      ) : null}

      {view.plan === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Set up planning</CardTitle>
            <CardDescription>
              Booking sets planning up automatically
              {defaultTemplate ? ` from "${defaultTemplate.name}", the default for ${typeLabel} events` : `, with Event basics only (no template is the default for ${typeLabel} events)`}.
              Set it up now to choose a template before the booking.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={setUpPlanning.bind(null, slug, event.id)} submitLabel="Set up planning" pendingLabel="Setting up…">
              <SelectField
                label="Template"
                name="template_id"
                defaultValue={defaultTemplate?.id ?? ""}
                options={templateOptions}
                placeholder="— Event basics only —"
                className="max-w-sm"
                hint={templateOptions.length === 0 ? <>No planning templates yet. <Link className="underline" href={`/staff/${slug}/planning-templates`}>Add the starter templates</Link>.</> : undefined}
              />
            </ActionForm>
          </CardContent>
        </Card>
      ) : (
        <PlanProgressProvider initial={view.progress} warnings={view.timeline_warnings} basics={view.basics.answers}>
          <SaveRegistryProvider>
            <PlanNavigation
              sections={planSections(view.structure)}
              stagesHeading="Stages, in order"
              extras={[
                ...(view.editing ? [{ key: CLIENT_EDITING_SECTION, label: "Deadline and history" }] : []),
                { key: PROVIDED_SECTION, label: "Event and proposal details" },
                { key: STRUCTURE_SECTION, label: "Structure and template" },
              ]}
            >
              {view.editing ? <EditingControl slug={slug} eventId={event.id} editing={view.editing} archived={archived} booked={booked} /> : null}
              {workspace()}
            </PlanNavigation>
          </SaveRegistryProvider>
        </PlanProgressProvider>
      )}
    </>
  );

  function workspace() {
    if (view.plan === null) return null;
    const plan = view.plan;
    const ev = event!;
    const sections = planSections(view.structure);
    const stageCount = sections.filter((s) => s.kind === "stage").length;
    const eventInfo = { date: ev.event_date, timezone: ev.timezone, venueName: ev.venue_name, venueAddress: ev.venue_address };
    const save = (itemId: string) => saveStaffItemAction.bind(null, slug, eventId, itemId);
    const general = new Map(view.structure.general.map((g) => [g.id, g]));
    const moments = new Map(view.structure.stages.flatMap((s) => s.moments).map((m) => [m.id, m]));
    const known = knownPeople(view.structure.stages, view.moments, view.stage_details);
    const ceremony = ceremonyDetails(view.structure.stages, view.stage_details);
    const card = "grid min-w-0 gap-5 rounded-xl border bg-card p-4 sm:p-5";
    return (
      <div id={WORKSPACE_ID} className="grid scroll-mt-4 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <PlanSidebar />
        <div className="grid min-w-0 gap-4">
          <SectionPicker />
          <UnsavedElsewhere />
          <MusicListsProvider
            initial={savedListsFrom(view.structure.stages, view.music)}
            introductions={savedIntroductions(view.structure.stages, view.moments)}
            processionalPeople={savedProcessionalPeople(view.structure.stages, view.moments)}
          >
            <PlanPanel view={null} testId="staff-plan-overview">
              <StaffPlanOverview />
              <section aria-labelledby="plan-facts-h" className="grid gap-3 rounded-xl border bg-card p-4 text-sm sm:p-5">
                <h3 id="plan-facts-h" className="text-sm font-semibold">Client and plan</h3>
                {clients.length > 0 ? (
                  <ul className="grid gap-1.5">
                    {clients.map((c) => (
                      <li key={c.email} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="font-medium [overflow-wrap:anywhere]">{c.name}</span>
                        {c.primary ? <Badge variant="outline">Primary</Badge> : null}
                        <a className="text-muted-foreground underline-offset-4 [overflow-wrap:anywhere] hover:underline" href={`mailto:${c.email}`}>{c.email}</a>
                        {c.phone ? (
                          <a className="inline-flex items-center gap-1 underline underline-offset-4" href={`tel:${c.phone.replace(/[^+0-9]/g, "")}`}>
                            <Phone aria-hidden className="size-3.5" />{c.phone}
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-muted-foreground">No client on this event yet.</p>}
                <p className="text-muted-foreground" data-testid="client-access">
                  {booked
                    ? archived
                      ? "The event is booked, but archived: client planning is closed."
                      : "The event is booked: the client (with verified access to this event) can open planning from their contract page and /my."
                    : "The client can open planning once the event is booked. Until then, only staff see it."}
                </p>
                <p className="text-muted-foreground">
                  {plan.origin === "template"
                    ? `Copied from the template "${plan.source_template_name}". Later edits to that template don't change this plan.`
                    : "Created with Event basics only, because no template was chosen."}{" "}
                  {plan.initialized_via === "booking" ? "Set up when the event was booked." : plan.initialized_via === "backfill" ? "Set up for an event booked before planning existed." : "Set up by staff."}
                </p>
                {plan.origin === "fallback" ? (
                  <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
                    Choose a template below to add this event&apos;s stages and moments, or add them one by one in Structure. Event basics
                    answers are kept either way.
                  </p>
                ) : null}
              </section>
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
                      eventVenue={{ name: ev.venue_name, address: ev.venue_address }}
                      djName={dj}
                      audience="staff"
                      save={save(view.basics.item_id)}
                      disabledReason={lockedReason}
                    />
                  ) : (
                    generalEditor(g, { moments: view.moments, eventContacts: view.event_contacts, known, djName: dj, audience: "staff", save, disabledReason: lockedReason })
                  );
                return (
                  <PlanPanel key={s.key} view={s.key} testId={`staff-section-${s.key}`}>
                    <section aria-labelledby={headingId(s.key)} className={card}>
                      <SectionHeader sectionKey={s.key} eyebrow="Event details" />
                      {g.key === "basics" ? (
                        <p className="text-xs text-muted-foreground">
                          Shared with the client, who can edit it too. Date and venue come from the event details.
                          {view.basics.updated_by ? ` Last saved by ${view.basics.updated_by === "client" ? "the client" : "staff"}.` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Shared with the client, who can edit it too. Notes here are visible to the client.</p>
                      )}
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
                <PlanPanel key={s.key} view={s.key} testId={`staff-stage-${s.key}`}>
                  <section aria-labelledby={headingId(s.key)} className={card}>
                    <SectionHeader sectionKey={s.key} eyebrow={`Stage ${stageNumber} of ${stageCount}`} />
                    {s.stageEditor ? (
                      <section data-plan-item={s.id} tabIndex={-1} aria-labelledby={`details-heading-${s.key}`} className="grid gap-3 text-sm outline-none">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 id={`details-heading-${s.key}`} className="text-base font-semibold [overflow-wrap:anywhere]">{s.detailsLabel ?? `${s.label} details`}</h3>
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
                            event={eventInfo}
                            djName={dj}
                            audience="staff"
                            save={save(s.id)}
                            disabledReason={lockedReason}
                          />
                        </SaveScope>
                      </section>
                    ) : null}
                    {s.moments.length > 0 ? (
                      <ul className="grid gap-2" aria-label={`Moments in ${s.label}`}>
                        {s.moments.map((m) => (
                          <li key={m.id}>
                            <PlanMoment moment={m} defaultOpen={single}>
                              {momentEditor(moments.get(m.id)!, { music: view.music, moments: view.moments, djName: dj, audience: "staff", event: eventInfo, ceremony, save, disabledReason: lockedReason })}
                            </PlanMoment>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {s.covered.map((c) => (
                      <p key={c.label} className="text-xs text-muted-foreground">{c.label}: {c.by ? `Included in ${c.by}` : "Included in another part of the plan"}.</p>
                    ))}
                    {s.unavailable.length > 0 ? (
                      <p className="text-xs text-muted-foreground">No editor yet, not counted in progress: {s.unavailable.join(", ")}.</p>
                    ) : null}
                    <SectionPager view={s.key} />
                  </section>
                </PlanPanel>
              );
            })}

            {view.editing ? (
              <PlanPanel view={CLIENT_EDITING_SECTION} testId="staff-client-editing">
                <ClientEditingCard slug={slug} eventId={ev.id} editing={view.editing} archived={archived} booked={booked} />
                <SectionPager view={CLIENT_EDITING_SECTION} />
              </PlanPanel>
            ) : null}

            <PlanPanel view={PROVIDED_SECTION} testId="staff-provided">
              <PanelHeading view={PROVIDED_SECTION}>Event and proposal details</PanelHeading>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>From the event details</CardTitle>
                    <CardDescription>Staff-entered and shown to the client read-only. <Link className="underline" href={base}>Edit on the event page</Link>.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-1 text-sm">
                      <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Type</dt><dd>{typeLabel}</dd></div>
                      <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Date</dt><dd>{formatEventDate(ev.event_date)}</dd></div>
                      <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Venue</dt><dd className="text-right">{ev.venue_name ?? "Not entered"}{ev.venue_address ? `, ${ev.venue_address}` : ""}</dd></div>
                    </dl>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>From the signed contract (frozen)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <AlreadyProvided imported={view.imported} djName={dj} audience="staff" />
                  </CardContent>
                </Card>
              </div>
              <SectionPager view={PROVIDED_SECTION} />
            </PlanPanel>

            <PlanPanel view={STRUCTURE_SECTION} testId="staff-structure">
              <PanelHeading view={STRUCTURE_SECTION}>Structure and template</PanelHeading>
              <DraftVersionProvider version={plan.structure_version}>
          <Card>
            <CardHeader>
              <CardTitle>Structure</CardTitle>
              <CardDescription>
                Only this event changes: its template and other events are untouched. Hiding keeps saved answers and can be undone with
                Restore; hiding a stage hides its moments. Hiding or adding sections never changes the proposal, contract, price, required
                gear or booking. The client can&apos;t change the structure.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StructureEditor
                mode="plan"
                general={view.structure.general}
                stages={view.structure.stages.map((s) => ({ ...s, editor: null, removable: true, moments: s.moments.map((m) => ({ ...m, removable: true })) }))}
                version={plan.structure_version}
                itemAction={planItemAction.bind(null, slug, ev.id)}
                addAction={addPlanItem.bind(null, slug, ev.id)}
                library={library ?? []}
                readOnly={archived}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Replace the structure with a template</CardTitle>
              <CardDescription>
                Applying a template is non-destructive: sections in both keep their answers and take the template&apos;s labels and order;
                new sections are added; sections the template doesn&apos;t have are hidden, not deleted, and can be restored. Your custom
                labels on this event are replaced.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {templateOptions.length > 0 ? (
                <ActionForm
                  action={applyPlanningTemplate.bind(null, slug, ev.id)}
                  submitLabel="Apply template"
                  pendingLabel="Applying…"
                  version={plan.structure_version}
                  variant="outline"
                >
                  <fieldset disabled={archived} className="grid gap-3">
                    <SelectField label="Template" name="template_id" options={templateOptions} placeholder="— choose —" required className="max-w-sm" />
                    <CheckboxField name="confirm" label="I understand this replaces the event's structure (answers are kept, other sections are hidden)." />
                  </fieldset>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No active planning templates. <Link className="underline" href={`/staff/${slug}/planning-templates`}>Manage planning templates</Link>.
                </p>
              )}
            </CardContent>
          </Card>
              </DraftVersionProvider>
              <SectionPager view={STRUCTURE_SECTION} />
            </PlanPanel>
          </MusicListsProvider>
        </div>
      </div>
    );
  }
}
