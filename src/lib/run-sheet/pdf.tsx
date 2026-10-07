import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatInstant } from "@/lib/planning/cutoff";
import { whenText, type PersonLine, type Row, type RunSheet, type SongLine, type StageSheet } from "./model";

/**
 * The DJ run sheet as a PDF, from the same projection as the live view.
 * A working document from the latest saved plan: never a contract, never
 * signed, never "final". Same bundled fonts as the signed contract PDF.
 *
 * react-pdf 4.9 notes (see the contract document): lineHeight sits next to
 * fontSize on text styles only, and render-prop footers have no width or
 * textAlign. Table headers are `fixed` inside their table so they repeat on
 * every page the table continues onto; rows never split.
 */

export const RUN_SHEET_FONT = "DejaVuSans";
const INK = "#111827";
const MUTED = "#4b5563";
const LINE = "#d1d5db";

const s = StyleSheet.create({
  page: { fontFamily: RUN_SHEET_FONT, fontSize: 9, color: INK, paddingTop: 40, paddingBottom: 52, paddingHorizontal: 36 },
  footerLeft: { position: "absolute", bottom: 22, left: 36, right: 120, fontSize: 7.5, color: "#6b7280" },
  footerRight: { position: "absolute", bottom: 22, right: 36, fontSize: 7.5, color: "#6b7280" },
  brand: { fontSize: 9, fontWeight: "bold", paddingBottom: 4, marginBottom: 6, borderBottomWidth: 2 },
  title: { fontSize: 16, fontWeight: "bold", lineHeight: 1.25, marginBottom: 3 },
  sub: { fontSize: 9.5, lineHeight: 1.35, color: "#374151" },
  stamp: { fontSize: 8.5, lineHeight: 1.35, color: MUTED, marginTop: 3 },
  archived: { fontSize: 9, fontWeight: "bold", color: "#92400e", borderWidth: 1, borderColor: "#d97706", padding: 4, marginTop: 6 },
  h1: { fontSize: 12.5, fontWeight: "bold", marginTop: 14, marginBottom: 6, paddingBottom: 2, borderBottomWidth: 1, borderBottomColor: INK },
  h2: { fontSize: 10.5, fontWeight: "bold", lineHeight: 1.3 },
  boxes: { flexDirection: "row", gap: 10, marginTop: 10 },
  box: { flex: 1, borderWidth: 0.75, borderColor: LINE, borderRadius: 3, padding: 6 },
  boxTitle: { fontSize: 8, fontWeight: "bold", color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 },
  pair: { flexDirection: "row", marginBottom: 2.5 },
  pairLabel: { width: 92, fontSize: 8.5, lineHeight: 1.3, color: MUTED, paddingRight: 4 },
  pairValue: { flex: 1, fontSize: 8.5, lineHeight: 1.3 },
  warnBox: { borderWidth: 0.75, borderColor: "#d97706", backgroundColor: "#fffbeb", borderRadius: 3, padding: 6, marginTop: 10 },
  warnLine: { fontSize: 8.5, lineHeight: 1.3, marginBottom: 1.5 },
  stageHead: { marginTop: 10, paddingVertical: 4, paddingHorizontal: 5, backgroundColor: "#f3f4f6", borderLeftWidth: 3 },
  stageMeta: { fontSize: 8.5, lineHeight: 1.3, color: "#374151", marginTop: 1 },
  instr: { fontSize: 8.5, lineHeight: 1.3, marginTop: 2 },
  tHead: { flexDirection: "row", borderBottomWidth: 0.75, borderBottomColor: "#9ca3af", paddingVertical: 2.5, marginTop: 3 },
  th: { fontSize: 7.5, fontWeight: "bold", color: MUTED, textTransform: "uppercase" },
  tRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb", paddingVertical: 3 },
  cWhen: { width: 74, paddingRight: 5 },
  cWho: { flex: 1.15, paddingRight: 5 },
  cSong: { flex: 1.15, paddingRight: 5 },
  cNotes: { flex: 1.2 },
  cell: { fontSize: 8.5, lineHeight: 1.3 },
  bold: { fontWeight: "bold" },
  muted: { color: MUTED },
  italic: { fontStyle: "italic" },
  warnText: { color: "#b45309" },
  listHead: { fontSize: 10, fontWeight: "bold", lineHeight: 1.3, marginTop: 10, marginBottom: 3 },
  listRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb", paddingVertical: 2 },
  listNo: { width: 22, fontSize: 8.5, lineHeight: 1.3, color: MUTED },
  listBody: { flex: 1, fontSize: 8.5, lineHeight: 1.3 },
  note: { fontSize: 8.5, lineHeight: 1.35, color: MUTED },
});

function Pairs({ items }: { items: { label: string; value: string; warn?: boolean }[] }) {
  return (
    <>
      {items.map((p, i) => (
        <View key={i} style={s.pair} wrap={false}>
          <Text style={s.pairLabel}>{p.label}</Text>
          <Text style={[s.pairValue, p.warn ? s.warnText : {}]}>{p.value}</Text>
        </View>
      ))}
    </>
  );
}

function PersonText({ p }: { p: PersonLine }) {
  return (
    <Text style={s.cell}>
      {/* One string per run: react-pdf may break (with a hyphen) between adjacent runs with no space. */}
      <Text style={s.bold}>{p.names}</Text>
      {p.pronunciation ? <Text>{` [${p.pronunciation}]`}</Text> : null}
      {p.role ? <Text style={s.muted}>{` · ${p.role}`}</Text> : null}
      {p.wording ? <Text>{`\nAnnounce: “${p.wording}”`}</Text> : null}
    </Text>
  );
}

function SongText({ song }: { song: SongLine }) {
  return (
    <Text style={s.cell}>
      {song.cue ? <Text style={s.muted}>{`${song.cue}: `}</Text> : null}
      <Text style={s.bold}>{song.title}</Text>
      <Text>{` by ${song.artist}`}</Text>
      {song.version ? <Text style={s.muted}>{` (${song.version})`}</Text> : null}
      {song.notes ? <Text>{`\n${song.notes}`}</Text> : null}
    </Text>
  );
}

function OverviewRow({ row, date }: { row: Row; date: string }) {
  const exact = row.when.kind === "time";
  return (
    <View style={s.tRow} wrap={false}>
      <View style={s.cWhen}>
        <Text style={[s.cell, exact ? s.bold : row.when.kind === "sequence" ? s.muted : s.italic]}>{whenText(row.when, date)}</Text>
      </View>
      <View style={s.cWho}>
        <Text style={[s.cell, s.bold]}>{row.title}</Text>
        {row.people.map((p, i) => <PersonText key={i} p={p} />)}
      </View>
      <View style={s.cSong}>
        {row.songs.map((song, i) => <SongText key={i} song={song} />)}
        {row.status ? <Text style={[s.cell, row.status.tone === "open" ? s.warnText : s.muted]}>{row.status.text}</Text> : null}
      </View>
      <View style={s.cNotes}>
        {row.notes.map((n, i) => <Text key={i} style={s.cell}>{n}</Text>)}
        {row.warning ? <Text style={[s.cell, s.warnText]}>{row.warning}</Text> : null}
      </View>
    </View>
  );
}

/** The overview's column labels: one copy per page (see RunSheetDocument). */
function ColumnHeader() {
  return (
    <View style={s.tHead} fixed>
      <Text style={[s.th, s.cWhen]}>Time / cue</Text>
      <Text style={[s.th, s.cWho]}>Moment and people</Text>
      <Text style={[s.th, s.cSong]}>Song</Text>
      <Text style={[s.th, s.cNotes]}>Instructions</Text>
    </View>
  );
}

/**
 * A stage: its heading, then its rows as direct siblings. react-pdf honours
 * minPresenceAhead only when the following siblings are plain unbreakable
 * rows, so this keeps the heading with at least its first row.
 */
function StageOverview({ stage, date, color }: { stage: StageSheet; date: string; color: string }) {
  const meta = [
    stage.times.map((t) => `${t.label}: ${whenText(t.when, date)}`).join(" · "),
    stage.location ? `Where: ${stage.location}` : "",
  ].filter(Boolean);
  return (
    <>
      <View style={[s.stageHead, { borderLeftColor: color }]} wrap={false} minPresenceAhead={stage.rows.length ? 45 : 0}>
        <Text style={s.h2}>{stage.label}</Text>
        {meta.map((m, i) => <Text key={i} style={s.stageMeta}>{m}</Text>)}
        {stage.instructions.map((p, i) => <Text key={i} style={s.instr}><Text style={s.bold}>{`${p.label}: `}</Text>{p.value}</Text>)}
      </View>
      {stage.rows.map((r) => <OverviewRow key={r.id} row={r} date={date} />)}
    </>
  );
}

export function RunSheetDocument({ sheet, revision }: { sheet: RunSheet; revision: string }) {
  const { event } = sheet;
  const asOf = formatInstant(sheet.asOf, event.timezone);
  const color = sheet.business.color;
  const detailed = sheet.stages.filter((st) => st.details.length > 0);
  // Do not play last, after the lists to play from, as on the planning page.
  const lists = [...sheet.musicLists.filter((l) => l.kind !== "exclusions"), ...sheet.musicLists.filter((l) => l.kind === "exclusions")];
  const hasDetails = detailed.length > 0 || sheet.vendors.state !== "hidden" || sheet.imported !== null;
  // Two flowing parts: the header and gig overview (with its column header
  // repeated on each of its pages), then details and music lists. Long events
  // simply run onto more pages; headings keep content with them.
  const footer = (
    <>
      <Text style={s.footerLeft} fixed>
        {`${sheet.business.name} · Run sheet · ${event.title} · Rev ${revision} · Latest saved plan as of ${asOf}`}
      </Text>
      <Text style={s.footerRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </>
  );
  return (
    <Document title={`Run sheet: ${event.title}`} author={sheet.business.name} subject={`DJ run sheet, revision ${revision}`} creator="Flux DJ" producer="Flux DJ" language="en-CA">
      <Page size="LETTER" style={s.page}>
        {footer}

        {/* A. Header */}
        <Text style={[s.brand, { borderBottomColor: color }]}>{`${sheet.business.name} · DJ run sheet`}</Text>
        <Text style={s.title}>{event.title}</Text>
        <Text style={s.sub}>{`${event.dateLabel} · ${event.typeLabel} · Times in ${event.timezone}`}</Text>
        <Text style={s.sub}>{[event.venueName, event.venueAddress].filter(Boolean).join(", ") || "Venue not entered yet"}</Text>
        <Text style={s.stamp}>{`Latest saved plan as of ${asOf} · Revision ${revision}. Exports with a different revision reflect later changes.`}</Text>
        {sheet.editing ? <Text style={s.stamp}>{sheet.editing}</Text> : null}
        {event.archived ? <Text style={s.archived}>ARCHIVED EVENT: kept for reference. The client can no longer open this plan.</Text> : null}
        {!sheet.planReady ? <Text style={[s.note, { marginTop: 10 }]}>Planning isn&apos;t set up for this event yet.</Text> : null}

        {sheet.planReady ? (
          <>
            {/* B. Gig overview */}
            <View style={s.boxes}>
              <View style={s.box}>
                <Text style={s.boxTitle}>Times and contacts</Text>
                <Pairs items={[...sheet.times, ...sheet.essentials]} />
              </View>
              <View style={s.box}>
                <Text style={s.boxTitle}>Preferences</Text>
                <Pairs items={sheet.preferences} />
                <Pairs items={sheet.musicLists.filter((l) => l.kind === "exclusions").map((l) => ({
                  label: l.label,
                  value: l.songs.length ? `${l.songs.length} ${l.songs.length === 1 ? "song" : "songs"}: see Music lists` : (l.status?.text ?? ""),
                }))} />
              </View>
            </View>
            {sheet.warnings.length > 0 ? (
              <View style={s.warnBox}>
                <Text style={s.boxTitle}>To check</Text>
                {sheet.warnings.filter((w) => w.kind !== "unresolved").map((w, i) => <Text key={i} style={s.warnLine}>{`• ${w.text}`}</Text>)}
                {sheet.warnings.some((w) => w.kind === "unresolved") ? (
                  <Text style={[s.warnLine, { marginTop: 2 }]}>
                    <Text style={s.bold}>Not answered yet: </Text>
                    {sheet.warnings.filter((w) => w.kind === "unresolved").map((w) => w.text).join(" · ")}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text style={s.h1} minPresenceAhead={80}>Gig overview</Text>
            {sheet.stages.length === 0 ? <Text style={s.note}>No stages in this plan.</Text> : null}
            {/* In flow here on the first page, then at the top of every overview page after it. */}
            {sheet.stages.length > 0 ? <ColumnHeader /> : null}
            {sheet.stages.map((st) => <StageOverview key={st.id} stage={st} date={event.date} color={color} />)}
          </>
        ) : null}
      </Page>

      {sheet.planReady && (hasDetails || lists.length > 0) ? (
        <Page size="LETTER" style={s.page}>
          {footer}
          {/* C. Detailed planning information */}
          {hasDetails ? <Text style={[s.h1, { marginTop: 0 }]} minPresenceAhead={80}>Planning details</Text> : null}
          {detailed.map((st) => (
            <View key={st.id} style={{ marginBottom: 6 }} wrap={false}>
              <Text style={[s.h2, { marginBottom: 2 }]}>{st.label}</Text>
              <Pairs items={st.details} />
            </View>
          ))}
          {sheet.vendors.state !== "hidden" ? (
            <View style={{ marginTop: 4 }}>
              <Text style={[s.h2, { marginBottom: 2 }]} minPresenceAhead={30}>Vendors and contacts</Text>
              {sheet.vendors.state === "listed"
                ? <Pairs items={sheet.vendors.entries.map((v) => ({ label: v.role, value: [v.name, v.phone, v.email, v.notes].filter(Boolean).join(" · ") }))} />
                : <Text style={s.note}>{sheet.vendors.state === "none" ? "No other vendors" : "Not answered yet"}</Text>}
            </View>
          ) : null}
          {sheet.imported ? (
            <View style={{ marginTop: 8 }}>
              <Text style={[s.h2, { marginBottom: 1 }]} minPresenceAhead={40}>From the signed proposal (frozen answers)</Text>
              <Text style={[s.note, { marginBottom: 3 }]}>
                {`Logistics answers the client gave with the accepted proposal, kept exactly as submitted. Captured ${formatInstant(sheet.imported.capturedAt, event.timezone)}.`}
              </Text>
              <Pairs items={sheet.imported.answers} />
            </View>
          ) : null}

          {/* D. Full music lists */}
          {lists.length > 0 ? <Text style={[s.h1, hasDetails ? {} : { marginTop: 0 }]} minPresenceAhead={80}>Music lists</Text> : null}
          {lists.map((l) => (
            <View key={l.id}>
              <Text style={[s.listHead, l.kind === "exclusions" ? { color: "#b91c1c" } : {}]} minPresenceAhead={30}>
                {`${l.kind === "exclusions" ? "DO NOT PLAY · " : ""}${l.stageLabel} · ${l.label}${l.songs.length ? ` (${l.songs.length})` : ""}`}
              </Text>
              {l.songs.length === 0 ? <Text style={s.note}>{l.status?.text ?? "No songs"}</Text> : null}
              {l.songs.map((song, i) => (
                <View key={i} style={s.listRow} wrap={false}>
                  <Text style={s.listNo}>{`${i + 1}.`}</Text>
                  <Text style={s.listBody}>
                    <Text style={s.bold}>{song.title}</Text>
                    <Text>{` · ${song.artist}`}</Text>
                    {song.version ? <Text style={s.muted}>{` (${song.version})`}</Text> : null}
                    {song.notes ? <Text style={s.muted}>{` · ${song.notes}`}</Text> : null}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </Page>
      ) : null}
    </Document>
  );
}
