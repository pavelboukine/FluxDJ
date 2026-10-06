import type { ReactNode } from "react";
import { isMusicEditor, type MusicAnswers } from "@/lib/planning/music";
import type { IntroductionsAnswers, McAnswers, ProcessionalAnswers, SpeechesAnswers } from "@/lib/planning/participants";
import type { ContactsAnswers, EventContact, MusicStyleAnswers, PreferencesAnswers } from "@/lib/planning/contacts";
import type { MomentAnswers, MusicLists, PlanStage, PlanStructure, SaveItemResult, StageDetails } from "@/lib/planning/view";
import type { ArrivalAnswers, TimedAnswers } from "@/lib/planning/timed";
import { ContactsEditor, MusicStyleEditor, PreferencesEditor, type KnownPeople } from "./general-editors";
import { ArrivalEditor, ProgramEditor, TimedEditorCard } from "./timed-editors";
import { MusicEditor } from "./music-editor";
import { IntroductionsEditor, McEditor, ProcessionalEditor, SpeechesEditor } from "./participants-editor";

type Moment = PlanStage["moments"][number];

/**
 * The editor for one moment, chosen by its library editor (never its label),
 * shared by the client and staff pages. Null when the moment has none yet.
 */
export function momentEditor(m: Moment, opts: {
  music: MusicLists;
  moments: MomentAnswers;
  djName: string;
  audience: "client" | "staff";
  event: { date: string; timezone: string; venueName: string | null; venueAddress: string | null };
  /** The visible Ceremony's details, for arrival answers that reuse them. */
  ceremony: Record<string, unknown> | null;
  save: (itemId: string) => (expectedRevision: number, answers: never) => Promise<SaveItemResult>;
  disabledReason?: string;
}): ReactNode {
  const saved = opts.moments[m.id] ?? opts.music[m.id];
  const common = {
    itemId: m.id, momentKey: m.key, label: m.label, initialRevision: saved?.revision ?? 0,
    djName: opts.djName, audience: opts.audience, disabledReason: opts.disabledReason,
  };
  const answers = (saved?.answers ?? {}) as Record<string, unknown>;
  const save = opts.save(m.id) as (expectedRevision: number, answers: unknown) => Promise<SaveItemResult>;
  if (isMusicEditor(m.editor)) return <MusicEditor {...common} editor={m.editor} initialAnswers={answers as MusicAnswers} save={save} />;
  switch (m.editor) {
    case "processional":
      return <ProcessionalEditor {...common} initialAnswers={answers as ProcessionalAnswers} save={save} />;
    case "introductions":
      return <IntroductionsEditor {...common} initialAnswers={answers as IntroductionsAnswers} save={save} />;
    case "speeches":
      return <SpeechesEditor {...common} initialAnswers={answers as SpeechesAnswers} save={save} event={opts.event} />;
    case "mc":
      return <McEditor {...common} initialAnswers={answers as McAnswers} save={save} />;
    case "music_style":
      return <MusicStyleEditor {...common} initialAnswers={answers as MusicStyleAnswers} save={save} />;
    case "arrival":
      return <ArrivalEditor {...common} initialAnswers={answers as ArrivalAnswers} save={save} event={opts.event} ceremony={opts.ceremony} />;
    case "program":
      return <ProgramEditor {...common} initialAnswers={answers as TimedAnswers} save={save} event={opts.event} />;
    case "activities":
    case "dedications":
      return <TimedEditorCard {...common} editor={m.editor} initialAnswers={answers as TimedAnswers} save={save} event={opts.event} />;
    default:
      return null;
  }
}

function savedLinks(stages: PlanStage[], moments: MomentAnswers, editor: string, field: string): { names: string; song_id?: string }[] {
  const item = stages.filter((s) => !s.disabled).flatMap((s) => s.moments).find((m) => !m.disabled && m.editor === editor);
  return ((item && (moments[item.id]?.answers[field] as { names: string; song_id?: string }[] | undefined)) ?? []);
}

/** Saved introductions of the visible plan, for the Entrance music songs they link to. */
export function savedIntroductions(stages: PlanStage[], moments: MomentAnswers) {
  return savedLinks(stages, moments, "introductions", "entries");
}

/** Saved Processional people of the visible plan, for the Couple entrance songs they link to. */
export function savedProcessionalPeople(stages: PlanStage[], moments: MomentAnswers) {
  return savedLinks(stages, moments, "processional", "participants");
}

type General = PlanStructure["general"][number];

/** The MC and officiant as their own editors hold them (never copied into contacts). */
export function knownPeople(stages: PlanStage[], moments: MomentAnswers, stageDetails: StageDetails): KnownPeople {
  const visible = stages.filter((s) => !s.disabled);
  const mcItem = visible.flatMap((s) => s.moments).find((m) => !m.disabled && m.editor === "mc");
  const mc = mcItem ? (moments[mcItem.id]?.answers as McAnswers | undefined) : undefined;
  const ceremony = visible.find((s) => s.editor === "stage_ceremony");
  const c = ceremony ? stageDetails[ceremony.id]?.answers : undefined;
  return {
    mc: mc?.mc === "dj" ? { dj: true } : mc?.mc === "other" ? { dj: false, name: mc.name, contact: mc.contact } : null,
    officiant: c && (c.officiant_name || c.officiant_contact) ? { name: c.officiant_name as string | undefined, contact: c.officiant_contact as string | undefined } : null,
  };
}

/** The editor for a general section (Event basics has its own), or null when it has none yet. */
export function generalEditor(g: General, opts: {
  moments: MomentAnswers;
  eventContacts: EventContact[];
  known: KnownPeople;
  djName: string;
  audience: "client" | "staff";
  save: (itemId: string) => (expectedRevision: number, answers: never) => Promise<SaveItemResult>;
  disabledReason?: string;
}): ReactNode {
  const saved = opts.moments[g.id];
  const common = {
    itemId: g.id, momentKey: g.key, label: g.label, initialRevision: saved?.revision ?? 0,
    djName: opts.djName, audience: opts.audience, disabledReason: opts.disabledReason,
    save: opts.save(g.id) as (expectedRevision: number, answers: unknown) => Promise<SaveItemResult>,
  };
  const answers = (saved?.answers ?? {}) as Record<string, unknown>;
  if (g.editor === "contacts") return <ContactsEditor {...common} initialAnswers={answers as ContactsAnswers} eventContacts={opts.eventContacts} known={opts.known} />;
  if (g.editor === "preferences") return <PreferencesEditor {...common} initialAnswers={answers as PreferencesAnswers} />;
  return null;
}

/** The visible Ceremony's saved details, or null. */
export function ceremonyDetails(stages: PlanStage[], stageDetails: StageDetails): Record<string, unknown> | null {
  const ceremony = stages.find((s) => !s.disabled && s.editor === "stage_ceremony");
  return ceremony ? (stageDetails[ceremony.id]?.answers ?? null) : null;
}
