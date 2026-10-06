import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BasicsEditor } from "@/components/planning/basics-editor";
import { AlreadyProvided, NotAvailableBadge, PlanCard, StageCards } from "@/components/planning/plan-overview";
import { ceremonyDetails, generalEditor, knownPeople, momentEditor, savedIntroductions, savedProcessionalPeople } from "@/components/planning/moment-editor";
import { MusicListsProvider } from "@/components/planning/music-editor";
import { ItemStatus, PlanProgressProvider, ProgressSummary } from "@/components/planning/progress";
import { StageDetailsEditor } from "@/components/planning/stage-details-editor";
import { savedListsFrom } from "@/lib/planning/music";
import { isStageEditor } from "@/lib/planning/stages";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { clientPlanningViewSchema, formatEventDate } from "@/lib/planning/view";
import { createClient } from "@/lib/supabase/server";
import { saveClientItemAction } from "./actions";

export const metadata: Metadata = { title: "Event planning", robots: { index: false, follow: false }, referrer: "strict-origin" };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-4 py-16 text-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

/**
 * The client's planning, in the order of the event. Every request is
 * checked in the database: verified identity, access to this exact event, a
 * booked event, and nothing archived. Only client-safe fields are returned.
 */
export default async function ClientPlanningPage({ params }: PageProps<"/[tenant]/planning/[eventId]">) {
  const { tenant: slug, eventId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(eventId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <Notice title="Sign in to plan your event">
        <p>Your planning is private. <Link className="underline" href="/login">Sign in with your email</Link> to open it.</p>
      </Notice>
    );
  }
  const { data } = await supabase.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: slug });
  const parsed = clientPlanningViewSchema.safeParse(data);
  const view = parsed.success ? parsed.data : { state: "unavailable" as const };
  if (view.state !== "available") {
    return (
      <Notice title="Planning isn't available">
        <p>
          Planning opens once your booking is confirmed. If it was, this account may not have access to this event. See{" "}
          <Link className="underline" href="/my">your events</Link>.
        </p>
      </Notice>
    );
  }

  const dj = view.brand.display_name;
  const brandStyle = { "--brand": view.brand.brand_colors.primary ?? "#111827" } as CSSProperties;
  const general = view.structure.general.filter((g) => g.key !== "basics");
  const basicsLabel = view.structure.general.find((g) => g.key === "basics")?.label ?? "Event basics";

  return (
    <main style={brandStyle} className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
      <header className="grid gap-1 border-b-4 border-[var(--brand)] pb-4">
        <p className="text-sm font-semibold">{dj}</p>
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">Planning: {view.event.title}</h1>
        <p className="text-sm text-muted-foreground">
          {formatEventDate(view.event.event_date)}
          {view.event.venue_name ? ` · ${view.event.venue_name}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">Event details provided by {dj}. Contact them to change the date or venue.</p>
      </header>

      <PlanProgressProvider initial={view.progress} warnings={view.timeline_warnings} basics={view.basics.answers}>
        <ProgressSummary />

        <section aria-labelledby="general-heading" className="grid gap-2">
          <h2 id="general-heading" className="text-lg font-semibold">Event details</h2>
          <PlanCard title={basicsLabel} open testId="section-basics">
            <BasicsEditor
              itemId={view.basics.item_id}
              initialAnswers={view.basics.answers}
              initialRevision={view.basics.revision}
              eventVenue={{ name: view.event.venue_name, address: view.event.venue_address }}
              djName={dj}
              audience="client"
              save={saveClientItemAction.bind(null, slug, eventId, view.basics.item_id)}
            />
          </PlanCard>
          {general.map((g) => {
            const editor = generalEditor(g, {
              moments: view.moments,
              eventContacts: view.event_contacts,
              known: knownPeople(view.structure.stages, view.moments, view.stage_details),
              djName: dj,
              audience: "client",
              save: (itemId) => saveClientItemAction.bind(null, slug, eventId, itemId),
            });
            return editor ? (
              <PlanCard key={g.id} title={g.label} badge={<ItemStatus itemId={g.id} />} testId={`section-${g.key}`}>{editor}</PlanCard>
            ) : (
              <PlanCard key={g.id} title={g.label} badge={<NotAvailableBadge />} testId={`section-${g.key}`}>
                <p className="text-muted-foreground">This section can&apos;t be filled in yet and isn&apos;t counted in progress.</p>
              </PlanCard>
            );
          })}
        </section>

        <section aria-labelledby="stages-heading" className="grid gap-2">
          <h2 id="stages-heading" className="text-lg font-semibold">Your event, in order</h2>
          <MusicListsProvider initial={savedListsFrom(view.structure.stages, view.music)} introductions={savedIntroductions(view.structure.stages, view.moments)} processionalPeople={savedProcessionalPeople(view.structure.stages, view.moments)}>
            <StageCards
              stages={view.structure.stages}
              renderDetails={(s) =>
                isStageEditor(s.editor) ? (
                  <StageDetailsEditor
                    itemId={s.id}
                    stageKey={s.key}
                    stageLabel={s.label}
                    editor={s.editor}
                    initialAnswers={view.stage_details[s.id]?.answers ?? {}}
                    initialRevision={view.stage_details[s.id]?.revision ?? 0}
                    event={{ date: view.event.event_date, timezone: view.event.timezone, venueName: view.event.venue_name, venueAddress: view.event.venue_address }}
                    djName={dj}
                    audience="client"
                    save={saveClientItemAction.bind(null, slug, eventId, s.id)}
                  />
                ) : null
              }
              renderMoment={(m) =>
              momentEditor(m, {
                music: view.music,
                moments: view.moments,
                djName: dj,
                audience: "client",
                event: { date: view.event.event_date, timezone: view.event.timezone, venueName: view.event.venue_name, venueAddress: view.event.venue_address },
                ceremony: ceremonyDetails(view.structure.stages, view.stage_details),
                save: (itemId) => saveClientItemAction.bind(null, slug, eventId, itemId),
              })
            }
          />
          </MusicListsProvider>
        </section>
      </PlanProgressProvider>

      {view.imported && view.imported.questions.length > 0 ? (
        <section aria-labelledby="provided-heading" className="grid gap-2">
          <h2 id="provided-heading" className="text-lg font-semibold">Already provided</h2>
          <AlreadyProvided imported={view.imported} djName={dj} audience="client" />
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        <Link className="underline" href="/my">Your events and contracts</Link>
      </p>
    </main>
  );
}
