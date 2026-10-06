import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider } from "@/components/app/draft-version";
import { CheckboxField, PageHeader, SelectField } from "@/components/app/fields";
import { BasicsEditor } from "@/components/planning/basics-editor";
import { ceremonyDetails, generalEditor, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "@/components/planning/moment-editor";
import { MusicListsProvider } from "@/components/planning/music-editor";
import { AlreadyProvided, hasMomentEditor, MomentCard, PlanCard } from "@/components/planning/plan-overview";
import { ItemStatus, PlanProgressProvider, ProgressSummary } from "@/components/planning/progress";
import { StageDetailsEditor } from "@/components/planning/stage-details-editor";
import { savedListsFrom } from "@/lib/planning/music";
import { isStageEditor } from "@/lib/planning/stages";
import { StructureEditor } from "@/components/planning/structure-editor";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { formatEventDate, staffPlanningViewSchema } from "@/lib/planning/view";
import { EVENT_TYPES } from "../../event-form";
import { addPlanItem, applyPlanningTemplate, planItemAction, saveStaffItemAction, setUpPlanning } from "./actions";
import { ClientEditingCard } from "./client-editing-card";

export default async function StaffPlanningPage({ params }: PageProps<"/staff/[tenant]/events/[eventId]/planning">) {
  const { tenant: slug, eventId } = await params;
  if (!UUID_RE.test(eventId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const { data: event } = await supabase
    .from("events")
    .select("id, title, event_type, event_date, timezone, venue_name, venue_address, lifecycle_status, booking_confirmed_at, archived_at")
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
  const visibleStages = view.plan === null ? [] : view.structure.stages.filter(
    (s) => !s.disabled && (isStageEditor(s.editor) || s.moments.some((m) => !m.disabled && hasMomentEditor(m))),
  );
  const booked = Boolean(event.booking_confirmed_at) && (event.lifecycle_status === "booked" || event.lifecycle_status === "completed");

  return (
    <>
      <PageHeader
        title={`Planning: ${event.title}`}
        description={<><Link className="underline" href={`/staff/${slug}/events/${event.id}`}>Back to the event</Link> · {formatEventDate(event.event_date)}</>}
        actions={archived ? <Badge variant="secondary">Archived</Badge> : null}
      />
      {archived ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          This event is archived. The client can&apos;t open or change planning, and planning can&apos;t be changed here until you unarchive
          the event. Saved answers are kept.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground" data-testid="client-access">
        {booked
          ? archived
            ? "The event is booked, but archived: client planning is closed."
            : "The event is booked: the client (with verified access to this event) can open planning from their contract page and /my."
          : "The client can open planning once the event is booked. Until then, only staff see it."}
      </p>

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
        <>
        {view.editing ? <ClientEditingCard slug={slug} eventId={event.id} editing={view.editing} archived={archived} booked={booked} /> : null}
        <DraftVersionProvider version={view.plan.structure_version}>
          <Card>
            <CardHeader>
              <CardTitle>About this plan</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>
                {view.plan.origin === "template"
                  ? `Copied from the template "${view.plan.source_template_name}". Later edits to that template don't change this plan.`
                  : "Created with Event basics only, because no template was chosen."}{" "}
                {view.plan.initialized_via === "booking" ? "Set up when the event was booked." : view.plan.initialized_via === "backfill" ? "Set up for an event booked before planning existed." : "Set up by staff."}
              </p>
              {view.plan.origin === "fallback" ? (
                <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
                  Choose a template below to add this event&apos;s stages and moments, or add them one by one in Structure. Event basics
                  answers are kept either way.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <PlanProgressProvider initial={view.progress} warnings={view.timeline_warnings} basics={view.basics.answers}>
            <Card>
              <CardHeader>
                <CardTitle>Event basics</CardTitle>
                <CardDescription>
                  Planning fields, shared with the client, who can edit them too. The date and venue are not repeated here: they come from the
                  event details. Proposal answers from the signed contract are shown separately and can&apos;t be edited.
                  {view.basics.updated_by ? ` Last saved by ${view.basics.updated_by === "client" ? "the client" : "staff"}.` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <ProgressSummary />
                <BasicsEditor
                  itemId={view.basics.item_id}
                  initialAnswers={view.basics.answers}
                  initialRevision={view.basics.revision}
                  eventVenue={{ name: event.venue_name, address: event.venue_address }}
                  djName={tenant.display_name}
                  audience="staff"
                  save={saveStaffItemAction.bind(null, slug, event.id, view.basics.item_id)}
                  disabledReason={archived ? "Unarchive the event to edit planning." : undefined}
                />
              </CardContent>
            </Card>

            {view.structure.general.some((g) => !g.disabled && (g.editor === "contacts" || g.editor === "preferences")) ? (
              <Card>
                <CardHeader>
                  <CardTitle>Contacts and preferences</CardTitle>
                  <CardDescription>
                    Shared with the client, who can edit them too. Planning contacts are separate from the event&apos;s clients and never change
                    them; coordination notes here are visible to the client. Preferences are for your review, not changes to services or price.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {view.structure.general.filter((g) => !g.disabled).map((g) => {
                    const editor = generalEditor(g, {
                      moments: view.moments,
                      eventContacts: view.event_contacts,
                      known: knownPeople(view.structure.stages, view.moments, view.stage_details),
                      djName: tenant.display_name,
                      audience: "staff",
                      save: (itemId) => saveStaffItemAction.bind(null, slug, event.id, itemId),
                      disabledReason: lockedReason,
                    });
                    return editor ? (
                      <PlanCard key={g.id} title={g.label} badge={<ItemStatus itemId={g.id} />} testId={`staff-section-${g.key}`}>{editor}</PlanCard>
                    ) : null;
                  })}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Stage details, music and people</CardTitle>
                <CardDescription>
                  Timing, location, preparation details, songs, introductions, MC and speeches for each stage, in your stage order (entering times never reorders it).
                  Shared with the client, who can edit them too. Hidden stages and moments keep their answers. Equipment answers are for
                  your review and never change the contracted package, gear or price.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {visibleStages.length === 0 ? <p className="text-sm text-muted-foreground">No visible stage has details or songs yet.</p> : null}
                <MusicListsProvider initial={savedListsFrom(view.structure.stages, view.music)} introductions={savedIntroductions(view.structure.stages, view.moments)} processionalPeople={savedProcessionalPeople(view.structure.stages, view.moments)}>
                  {visibleStages.map((s) => (
                    <PlanCard key={s.id} title={s.label} badge={isStageEditor(s.editor) ? <ItemStatus itemId={s.id} /> : undefined} testId={`staff-stage-${s.key}`}>
                      {isStageEditor(s.editor) ? (
                        <StageDetailsEditor
                          itemId={s.id}
                          stageKey={s.key}
                          stageLabel={s.label}
                          editor={s.editor}
                          initialAnswers={view.stage_details[s.id]?.answers ?? {}}
                          initialRevision={view.stage_details[s.id]?.revision ?? 0}
                          event={{ date: event.event_date, timezone: event.timezone, venueName: event.venue_name, venueAddress: event.venue_address }}
                          djName={tenant.display_name}
                          audience="staff"
                          save={saveStaffItemAction.bind(null, slug, event.id, s.id)}
                          disabledReason={lockedReason}
                        />
                      ) : null}
                      {s.moments.map((m) =>
                        !m.disabled && hasMomentEditor(m) ? (
                          <MomentCard key={m.id} moment={m}>
                            {momentEditor(m, {
                              music: view.music,
                              moments: view.moments,
                              djName: tenant.display_name,
                              audience: "staff",
                              event: { date: event.event_date, timezone: event.timezone, venueName: event.venue_name, venueAddress: event.venue_address },
                              ceremony: ceremonyDetails(view.structure.stages, view.stage_details),
                              save: (itemId) => saveStaffItemAction.bind(null, slug, event.id, itemId),
                              disabledReason: lockedReason,
                            })}
                          </MomentCard>
                        ) : null,
                      )}
                    </PlanCard>
                  ))}
                </MusicListsProvider>
              </CardContent>
            </Card>
          </PlanProgressProvider>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>From the event details</CardTitle>
                <CardDescription>Staff-entered and shown to the client read-only. <Link className="underline" href={`/staff/${slug}/events/${event.id}`}>Edit on the event page</Link>.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-1 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Type</dt><dd>{typeLabel}</dd></div>
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Date</dt><dd>{formatEventDate(event.event_date)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Venue</dt><dd className="text-right">{event.venue_name ?? "Not entered"}{event.venue_address ? `, ${event.venue_address}` : ""}</dd></div>
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>From the signed contract (frozen)</CardTitle>
              </CardHeader>
              <CardContent>
                <AlreadyProvided imported={view.imported} djName={tenant.display_name} audience="staff" />
              </CardContent>
            </Card>
          </div>

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
                version={view.plan.structure_version}
                itemAction={planItemAction.bind(null, slug, event.id)}
                addAction={addPlanItem.bind(null, slug, event.id)}
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
                  action={applyPlanningTemplate.bind(null, slug, event.id)}
                  submitLabel="Apply template"
                  pendingLabel="Applying…"
                  version={view.plan.structure_version}
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
        </>
      )}
    </>
  );
}
