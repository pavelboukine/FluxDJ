import Link from "next/link";
import { PdfDownloadLink } from "@/components/app/pwa";
import { Badge } from "@/components/ui/badge";
import { formatInstant } from "@/lib/planning/cutoff";
import { whenText, type PersonLine, type Row, type RunSheet, type SongLine, type StageSheet } from "@/lib/run-sheet/model";
import { cn } from "@/lib/utils";

/**
 * The live run sheet for staff on gig night: read-only, phone first, from
 * the same projection as the PDF. No edit forms: each stage links to its
 * section in planning. On wide screens the essentials and what to check sit
 * beside the schedule; on phones they come first.
 * Long playlists sit in collapsed lists so ceremony and entrance cues stay
 * on screen; Do not play is linked from the top.
 */

function Person({ p }: { p: PersonLine }) {
  return (
    <p className="[overflow-wrap:anywhere]">
      <span className="font-semibold">{p.names}</span>
      {p.pronunciation ? <span className="text-foreground"> [{p.pronunciation}]</span> : null}
      {p.role ? <span className="text-muted-foreground"> · {p.role}</span> : null}
      {p.wording ? <span className="block">Announce: “{p.wording}”</span> : null}
    </p>
  );
}

function Song({ s }: { s: SongLine }) {
  return (
    <p className="[overflow-wrap:anywhere]">
      <span aria-hidden>♪ </span>
      {s.cue ? <span className="text-muted-foreground">{s.cue}: </span> : null}
      <span className="font-semibold">{s.title}</span> by {s.artist}
      {s.version ? <span className="text-muted-foreground"> ({s.version})</span> : null}
      {s.notes ? <span className="block text-sm">{s.notes}</span> : null}
    </p>
  );
}

function RowCard({ row, date }: { row: Row; date: string }) {
  const exact = row.when.kind === "time";
  return (
    <li className="grid gap-1 border-t py-3 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4" data-testid="run-row">
      <p className={cn(exact ? "text-base font-semibold tabular-nums" : row.when.kind === "sequence" ? "text-sm text-muted-foreground" : "text-sm italic")}>
        {whenText(row.when, date)}
      </p>
      <div className="grid min-w-0 gap-1 text-sm">
        <p className="text-base font-semibold">{row.title}</p>
        {row.people.map((p, i) => <Person key={i} p={p} />)}
        {row.songs.map((s, i) => <Song key={i} s={s} />)}
        {row.status ? (
          <p className={row.status.tone === "open" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{row.status.text}</p>
        ) : null}
        {row.notes.map((n, i) => <p key={i} className="whitespace-pre-line [overflow-wrap:anywhere]">{n}</p>)}
        {row.warning ? <p className="text-amber-700 dark:text-amber-400">{row.warning}</p> : null}
      </div>
    </li>
  );
}

function Pairs({ items }: { items: { label: string; value: string; phone?: string; warn?: boolean }[] }) {
  return (
    <dl className="grid gap-2 text-sm">
      {items.map((p, i) => (
        <div key={i} className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
          <dt className="text-muted-foreground">{p.label}</dt>
          <dd className={cn("whitespace-pre-line [overflow-wrap:anywhere]", p.warn && "text-amber-700 dark:text-amber-400")}>
            {p.value}
            {p.phone ? (
              <>
                {" "}
                <a className="ml-1 inline-flex min-h-9 items-center rounded-md border px-2.5 font-medium underline-offset-4 hover:underline" href={`tel:${p.phone.replace(/[^+0-9]/g, "")}`}>
                  Call<span className="sr-only"> {p.label}</span>
                </a>
              </>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stage({ stage, date, planningHref }: { stage: StageSheet; date: string; planningHref: string }) {
  return (
    <section id={`stage-${stage.key}`} aria-labelledby={`stage-${stage.key}-h`} className="grid scroll-mt-4 gap-2 rounded-xl border bg-card p-4 sm:p-5" data-testid={`run-stage-${stage.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`stage-${stage.key}-h`} className="text-xl font-semibold tracking-tight">{stage.label}</h2>
        <Link className="inline-flex min-h-9 items-center text-sm underline underline-offset-4" href={`${planningHref}?section=${encodeURIComponent(stage.key)}`}>
          Edit in planning<span className="sr-only"> ({stage.label})</span>
        </Link>
      </div>
      {stage.times.length ? (
        <p className="text-base">
          {stage.times.map((t, i) => (
            <span key={i} className="mr-3 inline-block">
              <span className="text-muted-foreground">{t.label}: </span>
              <span className={t.when.kind === "time" ? "font-semibold tabular-nums" : t.when.kind === "missing" ? "text-amber-700 dark:text-amber-400" : ""}>{whenText(t.when, date)}</span>
            </span>
          ))}
        </p>
      ) : null}
      {stage.location ? <p className="text-sm [overflow-wrap:anywhere]"><span className="text-muted-foreground">Where: </span>{stage.location}</p> : null}
      {stage.instructions.map((p, i) => (
        <p key={i} className="rounded-lg bg-muted/60 p-2 text-sm whitespace-pre-line [overflow-wrap:anywhere]"><span className="font-semibold">{p.label}: </span>{p.value}</p>
      ))}
      {stage.details.length ? <Pairs items={stage.details} /> : null}
      {stage.rows.length ? <ul className="grid">{stage.rows.map((r) => <RowCard key={r.id} row={r} date={date} />)}</ul> : null}
    </section>
  );
}

export function RunSheetView({ sheet, revision, pdfHref, planningHref, refreshHref }: { sheet: RunSheet; revision: string; pdfHref: string; planningHref: string; refreshHref: string }) {
  const { event } = sheet;
  const tz = event.timezone;
  const doNotPlay = sheet.musicLists.filter((l) => l.kind === "exclusions");
  const doNotPlayCount = doNotPlay.reduce((n, l) => n + l.songs.length, 0);
  // Timing problems and song contradictions always show; unanswered details fold away under a count.
  const urgent = sheet.warnings.filter((w) => w.kind !== "unresolved");
  const open = sheet.warnings.filter((w) => w.kind === "unresolved");
  return (
    <div className="grid gap-5">
      <header className="grid gap-2">
        <p className="text-sm font-semibold">{sheet.business.name} · DJ run sheet</p>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
          {event.title} {event.archived ? <Badge variant="secondary">Archived</Badge> : null}
        </h1>
        <p className="text-sm">{event.dateLabel} · {event.typeLabel} · Times in {tz}</p>
        <p className="text-sm [overflow-wrap:anywhere]">{[event.venueName, event.venueAddress].filter(Boolean).join(", ") || "Venue not entered yet"}</p>
        <p className="text-sm text-muted-foreground" data-testid="run-sheet-as-of">
          Latest saved plan as of {formatInstant(sheet.asOf, tz)} · Revision {revision}
        </p>
        {sheet.editing ? <p className="text-sm text-muted-foreground">{sheet.editing}</p> : null}
        {event.archived ? <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">This event is archived. The run sheet stays available to staff for reference.</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <PdfDownloadLink className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground" href={pdfHref} fallbackName="run-sheet.pdf">Download run sheet PDF</PdfDownloadLink>
          <Link className="inline-flex min-h-11 items-center rounded-lg border bg-card px-4 text-sm" href={refreshHref} prefetch={false}>Refresh</Link>
          <Link className="inline-flex min-h-11 items-center rounded-lg border bg-card px-4 text-sm" href={planningHref}>Edit planning</Link>
        </div>
      </header>

      {!sheet.planReady ? (
        <p className="text-sm">Planning isn&apos;t set up for this event yet. <Link className="underline" href={planningHref}>Set it up</Link>.</p>
      ) : (
        <>
          <nav aria-label="Run sheet sections" className="flex flex-wrap gap-2 text-sm">
            <a className="inline-flex min-h-9 items-center rounded-full border bg-card px-3" href="#essentials">Essentials</a>
            {sheet.warnings.length ? <a className="inline-flex min-h-9 items-center rounded-full border border-amber-500 bg-card px-3" href="#to-check">To check</a> : null}
            {sheet.stages.map((s) => <a key={s.id} className="inline-flex min-h-9 items-center rounded-full border bg-card px-3" href={`#stage-${s.key}`}>{s.label}</a>)}
            {sheet.musicLists.length ? <a className="inline-flex min-h-9 items-center rounded-full border bg-card px-3" href="#music">Music lists</a> : null}
            {doNotPlay.length ? <a className="inline-flex min-h-9 items-center rounded-full border border-red-600 bg-card px-3 text-red-700 dark:text-red-400" href="#do-not-play">Do not play ({doNotPlayCount})</a> : null}
          </nav>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <aside className="grid min-w-0 gap-5 lg:col-start-2 lg:row-start-1">
              <section id="essentials" aria-labelledby="essentials-h" className="grid scroll-mt-4 gap-3 rounded-xl border bg-card p-4">
                <h2 id="essentials-h" className="text-lg font-semibold">Essentials</h2>
                <Pairs items={[...sheet.times, ...sheet.essentials]} />
                <h3 className="pt-1 font-medium">Preferences</h3>
                <Pairs items={sheet.preferences} />
              </section>

              {sheet.warnings.length ? (
                <section id="to-check" aria-labelledby="to-check-h" className="grid scroll-mt-4 gap-2 rounded-xl border border-amber-500/60 bg-amber-500/10 p-4" data-testid="run-to-check">
                  <h2 id="to-check-h" className="text-lg font-semibold">To check</h2>
                  {urgent.length ? (
                    <ul className="grid list-disc gap-1 pl-5 text-sm">
                      {urgent.map((w, i) => <li key={i} className="[overflow-wrap:anywhere]">{w.text}</li>)}
                    </ul>
                  ) : null}
                  {open.length ? (
                    <details className="group text-sm">
                      <summary className="cursor-pointer font-medium">Not answered yet ({open.length} {open.length === 1 ? "section" : "sections"})</summary>
                      <ul className="mt-1 grid list-disc gap-1 pl-5">
                        {open.map((w, i) => <li key={i} className="[overflow-wrap:anywhere]">{w.text}</li>)}
                      </ul>
                    </details>
                  ) : null}
                </section>
              ) : null}

            </aside>

            <div className="grid min-w-0 gap-5 lg:col-start-1 lg:row-start-1">
              {sheet.stages.map((s) => <Stage key={s.id} stage={s} date={event.date} planningHref={planningHref} />)}

              {sheet.vendors.state !== "hidden" ? (
                <section aria-labelledby="vendors-h" className="grid gap-2 rounded-xl border bg-card p-4 sm:p-5">
                  <h2 id="vendors-h" className="text-lg font-semibold">Vendors and contacts</h2>
                  {sheet.vendors.state === "listed" ? (
                    <Pairs items={sheet.vendors.entries.map((v) => ({ label: v.role, value: [v.name, v.email, v.notes].filter(Boolean).join(" · "), phone: v.phone }))} />
                  ) : <p className="text-sm text-muted-foreground">{sheet.vendors.state === "none" ? "No other vendors" : "Not answered yet"}</p>}
                </section>
              ) : null}

              {sheet.musicLists.length ? (
                <section id="music" aria-labelledby="music-h" className="grid scroll-mt-4 gap-2">
                  <h2 id="music-h" className="text-lg font-semibold">Music lists</h2>
                  {sheet.musicLists.map((l) => {
                    const exclusions = l.kind === "exclusions";
                    return (
                      <details key={l.id} id={exclusions ? "do-not-play" : undefined} open={exclusions} className={cn("group scroll-mt-4 rounded-xl border bg-card", exclusions && "border-red-600/60")} data-testid={`run-list-${l.key}`}>
                        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                          <span className={cn("font-medium", exclusions && "text-red-700 dark:text-red-400")}>
                            {exclusions ? "Do not play" : `${l.stageLabel} · ${l.label}`}
                            {l.songs.length ? ` (${l.songs.length})` : ""}
                          </span>
                          <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
                        </summary>
                        <div className="border-t px-4 py-3 text-sm">
                          {l.songs.length === 0 ? <p className="text-muted-foreground">{l.status?.text ?? "No songs"}</p> : (
                            <ol className="grid list-decimal gap-1 pl-6">
                              {l.songs.map((s, i) => (
                                <li key={i} className="[overflow-wrap:anywhere]">
                                  <span className="font-medium">{s.title}</span> · {s.artist}
                                  {s.version ? <span className="text-muted-foreground"> ({s.version})</span> : null}
                                  {s.notes ? <span className="text-muted-foreground"> · {s.notes}</span> : null}
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </section>
              ) : null}

              {sheet.imported ? (
                <details className="group rounded-xl border bg-card">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <span className="font-medium">From the signed proposal (frozen answers)</span>
                    <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
                  </summary>
                  <div className="grid gap-2 border-t px-4 py-3">
                    <p className="text-sm text-muted-foreground">Logistics answers the client gave with the accepted proposal, kept exactly as submitted.</p>
                    <Pairs items={sheet.imported.answers} />
                  </div>
                </details>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
