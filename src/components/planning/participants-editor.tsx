"use client";

import { useState, type ReactNode } from "react";
import { Music } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addNewSongs,
  withMusic,
  emptyPerson,
  emptySpeech,
  entryField,
  introductionsAnswersFromForm,
  introductionsForm,
  linksBySong,
  hasOtherMc,
  mcAnswersFromForm,
  newSongProblem,
  mcForm,
  processionalAnswersFromForm,
  processionalForm,
  songLabel,
  speechesAnswersFromForm,
  speechesForm,
  withNewSongs,
  type IntroductionsAnswers,
  type IntroductionsForm,
  type ListChoice,
  type McAnswers,
  type McChoice,
  type McForm,
  type PersonForm,
  type ProcessionalAnswers,
  type ProcessionalForm,
  type ProcessionalPersonForm,
  type SongPersonForm,
  type EntryMusic,
  type SpeechForm,
  type SpeechesAnswers,
  type SpeechesForm,
  type Timing,
} from "@/lib/planning/participants";
import { MUSIC_RULES, type MusicForm, type SongForm } from "@/lib/planning/music";
import { EQUIPMENT_NOTE, nextDayLabel } from "@/lib/planning/stages";
import type { SaveItemResult } from "@/lib/planning/view";
import { FieldBox, describedBy } from "./basics-editor";
import { TimeField } from "./time-field";
import { MusicSection, usePlanSongs } from "./music-editor";
import { SongPicker, type SongGroup, type SongPickerField } from "./song-picker";
import { Choices } from "./choice-list";
import { AddButton, AddDisclosure, EditToggle, ITEM_ROWS, ItemRow, RemoveButton, ReorderButtons, UndoBar } from "./item-list";
import { ItemChecklist, useEditingClosed } from "./progress";
import { zoneName } from "@/lib/planning/cutoff";
import { discussLabel, djIdentity, djRef } from "@/lib/planning/dj";
import { SaveStatus, useAutosave } from "./use-autosave";

const newId = () => crypto.randomUUID();

export type Common<A> = {
  itemId: string;
  momentKey: string;
  label: string;
  initialAnswers: A;
  initialRevision: number;
  djName: string;
  /** The DJ handling the event (events.dj_name, else tenants.dj_name), named only where planning asks who does what. */
  djDisplayName?: string | null;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: A) => Promise<SaveItemResult>;
  disabledReason?: string;
};

export function Frame({ props, hint, children, status }: { props: Common<unknown>; hint?: ReactNode; children: ReactNode; status: ReactNode }) {
  return (
    <div className="grid gap-3" data-testid={`editor-${props.momentKey}`}>
      <ItemChecklist itemId={props.itemId} title={props.label} djName={props.djName} audience={props.audience} />
      {hint ? <p data-plan-help className="text-xs text-muted-foreground">{hint}</p> : null}
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      {children}
      {props.disabledReason ? null : status}
    </div>
  );
}

/** The shared planning choice list (see choice-list.tsx), kept importable from here. */
export { Choices };

/** "Name (pronunciation)". The guide sits beside the name, as typed. */
function NameLine({ index, name, pronunciation }: { index: number; name: string; pronunciation: string }) {
  return (
    <p className="text-[0.9375rem] leading-snug font-medium [overflow-wrap:anywhere]">
      <span className="font-normal text-plan-ink-2 tabular-nums">{index + 1}. </span>
      {name.trim() || "Unnamed"}
      {pronunciation.trim() ? <span className="font-normal text-plan-ink-2"> (say: {pronunciation.trim()})</span> : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Ordered entries: add complete, edit in place, move, remove with undo
// ---------------------------------------------------------------------------

export function EntryList<E extends { id: string }>(props: {
  base: string;
  noun: string;
  entries: E[];
  setEntries: (entries: E[], clears?: string[]) => void;
  readOnly: boolean;
  canAdd: boolean;
  addBlockedText?: string;
  max: number;
  nameOf: (e: E) => string;
  summary: (e: E, index: number) => ReactNode;
  fields: (e: E, onChange: (changes: Partial<E>) => void, errorFor: (field: string) => string | null, idPrefix: string) => ReactNode;
  newEntry: (id: string) => E;
  /** Why a new entry can't be added yet (needed fields), or null. */
  check: (e: E) => { field: string; message: string } | null;
  fieldError: { field: string; message: string } | null;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ entry: E; index: number } | null>(null);
  const [draft, setDraft] = useState<E>(() => props.newEntry(newId()));
  const [draftError, setDraftError] = useState<{ field: string; message: string } | null>(null);
  const { entries, setEntries } = props;
  const clears = (id: string) => ["entries", ...["names", "role", "pronunciation", "wording", "notes", "song_id", "music", "speaker", "timing", "time", "next_day", "cue", "duration", "av_notes", "name", "business", "phone", "email", "title", "recipient", "presenter", "host", "participants", "relationship", "message", "song_title", "song_artist", "song_version", "song_link", "song_notes"].map((f) => entryField(id, f))];
  const errorFor = (id: string) => (field: string) => (props.fieldError?.field === entryField(id, field) ? props.fieldError.message : null);

  function move(index: number, by: -1 | 1) {
    const next = [...entries];
    const [e] = next.splice(index, 1);
    next.splice(index + by, 0, e);
    setEntries(next);
  }
  function remove(index: number) {
    const entry = entries[index];
    setEntries(entries.filter((_, i) => i !== index), clears(entry.id));
    setRemoved({ entry, index });
    if (editing === entry.id) setEditing(null);
  }
  function undo() {
    if (!removed || entries.some((e) => e.id === removed.entry.id)) return setRemoved(null);
    const next = [...entries];
    next.splice(Math.min(removed.index, next.length), 0, removed.entry);
    setEntries(next);
    setRemoved(null);
  }
  function add() {
    const problem = props.check(draft);
    if (problem) return setDraftError(problem);
    // The draft's id goes in once: a doubled click finds it already there.
    if (!entries.some((e) => e.id === draft.id)) setEntries([...entries, draft]);
    setDraft(props.newEntry(newId()));
    setDraftError(null);
    setRemoved(null);
  }

  return (
    <div className="grid gap-3">
      {entries.length > 0 ? (
        <ol className={ITEM_ROWS} aria-label={`${props.noun}s`}>
          {entries.map((e, index) => {
            const name = props.nameOf(e);
            const hasError = props.fieldError?.field.startsWith(`entry:${e.id}:`);
            const open = editing === e.id || hasError;
            return (
              <ItemRow
                key={e.id}
                testId="entry-row"
                summary={props.summary(e, index)}
                actions={!props.readOnly ? (
                  <>
                    <ReorderButtons name={name} index={index} count={entries.length} onMove={(by) => move(index, by)} />
                    <EditToggle editing={editing === e.id} name={name} onToggle={() => setEditing(editing === e.id ? null : e.id)} />
                  </>
                ) : null}
                panel={open && !props.readOnly ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {props.fields(e, (changes) => setEntries(entries.map((x) => (x.id === e.id ? { ...x, ...changes } : x)), clears(e.id)), errorFor(e.id), `${props.base}-${e.id}`)}
                    </div>
                    <RemoveButton name={name} onClick={() => remove(index)} />
                  </>
                ) : null}
              />
            );
          })}
        </ol>
      ) : null}
      {removed ? <UndoBar onUndo={undo}>Removed &ldquo;{props.nameOf(removed.entry)}&rdquo;.</UndoBar> : null}
      {props.readOnly ? null : !props.canAdd ? (
        props.addBlockedText ? <p className="text-xs text-plan-ink-2">{props.addBlockedText}</p> : null
      ) : entries.length >= props.max ? (
        <p className="text-xs text-plan-ink-2">This list has the maximum of {props.max} entries.</p>
      ) : (
        <AddDisclosure testId={`${props.base}-add`} label={`Add ${props.noun.toLowerCase()}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            {props.fields(draft, (changes) => { setDraft((d) => ({ ...d, ...changes })); setDraftError(null); }, (field) => (draftError?.field === field ? draftError.message : null), `${props.base}-new`)}
          </div>
          <AddButton onClick={add}>Add</AddButton>
        </AddDisclosure>
      )}
      {props.fieldError?.field === "entries" ? <p role="alert" className="text-xs font-medium text-destructive">{props.fieldError.message}</p> : null}
    </div>
  );
}

/**
 * A labelled text field. Wide ones (rows or `wide`) take the whole row of a
 * two-column grid; col-span-full never adds a column to a one-column grid.
 */
export const text = (id: string, label: string, value: string, onChange: (v: string) => void, error: string | null,
  opts: { hint?: string; rows?: number; wide?: boolean; type?: "email" | "tel"; inputMode?: "email" | "tel" | "url"; autoComplete?: string } = {}) => (
  <FieldBox key={id} id={id} label={label} error={error} hint={opts.hint} className={opts.rows || opts.wide ? "col-span-full" : undefined}>
    {opts.rows ? (
      <Textarea id={id} rows={opts.rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy(id, error, opts.hint)} />
    ) : (
      <Input id={id} type={opts.type} inputMode={opts.inputMode} autoComplete={opts.autoComplete} value={value} onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)} aria-describedby={describedBy(id, error, opts.hint)} />
    )}
  </FieldBox>
);

export const PRONUNCIATION_HINT = 'Written as it sounds, for example "ah-LEK-sah DOO-bwah".';

const checkPerson = (p: PersonForm) => (p.names.trim() ? null : { field: "names", message: "Enter the name or names." });

// ---------------------------------------------------------------------------
// People with songs: the Processional and the grand entrance order
// ---------------------------------------------------------------------------

/**
 * One way of listing people or groups in order, each with the song they
 * enter to, chosen or typed right with them (SongPicker). The Processional
 * and the reception's grand entrance order share it; they differ only in
 * what is asked per entry: nobody is announced while walking down the aisle,
 * so the Processional asks no pronunciation or announcement (older guides are
 * kept, and shown to staff), while the grand entrance asks both, optionally.
 */
type SongPeople = {
  audience: "client" | "staff";
  people: SongPersonForm[];
  /** Songs entries can link to, in the picker's groups. */
  groups: SongGroup[];
  missing: string;
  room: number;
  /** "The processional": for "... has the maximum of 12 songs". */
  listName: string;
  announced: boolean;
  /** Ask each entry's music explicitly: a song, the DJ's choice, or not decided yet (the grand entrance). */
  musicChoice: boolean;
  labels: { names: string; namesHint: string; roleHint: string; song: string; shared: string; notes: string; notesHint: string };
};

function songPersonSummary(c: SongPeople) {
  const known = new Map(c.groups.flatMap((g) => g.songs).map((s) => [s.id, s]));
  return function renderSongPersonSummary(p: SongPersonForm, index: number) {
    const song = p.song_id ? known.get(p.song_id) : undefined;
    const sameAsAbove = Boolean(p.song_id) && c.people[index - 1]?.song_id === p.song_id;
    return (
      <>
        <NameLine index={index} name={p.names} pronunciation={c.announced || c.audience === "staff" ? p.pronunciation : ""} />
        {p.role.trim() ? <p className="text-xs text-plan-ink-2 [overflow-wrap:anywhere]">{p.role}</p> : null}
        {c.announced && p.wording.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Announcement: {p.wording}</p> : null}
        {song ? (
          <p className="flex items-start gap-1.5 text-xs [overflow-wrap:anywhere]">
            <Music aria-hidden className="mt-px size-3.5 shrink-0 text-brand-ink" />
            <span>{sameAsAbove ? "Same song as the entry above: " : "Song: "}{songLabel(song)}</span>
          </p>
        ) : p.song_id ? (
          <p className="text-xs text-status-attention">{c.missing}</p>
        ) : c.musicChoice && p.music === "dj_choice" ? (
          <p className="flex items-center gap-1.5 text-xs"><Music aria-hidden className="size-3.5 shrink-0 text-brand-ink" />Music: DJ&apos;s choice</p>
        ) : c.musicChoice ? (
          <p className="text-xs text-plan-ink-2">Music not decided yet</p>
        ) : (
          <p className="text-xs text-plan-ink-2">No song chosen yet</p>
        )}
        {p.notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Instructions: {p.notes}</p> : null}
      </>
    );
  };
}

function songPersonFields(c: SongPeople) {
  return function renderSongPersonFields(p: SongPersonForm, onChange: (changes: Partial<SongPersonForm>) => void, errorFor: (f: string) => string | null, idPrefix: string) {
    const draft = p.new_song ?? null;
    const pending = draft?.use ? newSongProblem(draft, c.room, c.listName) : null;
    const songError = (f: SongPickerField) => errorFor(f) ?? (pending?.field === f ? pending.message : null);
    const listed = c.people.some((x) => x.id === p.id);
    return (
      <>
        {text(`${idPrefix}-names`, c.labels.names, p.names, (v) => onChange({ names: v }), errorFor("names"), { hint: c.labels.namesHint, wide: true })}
        {text(`${idPrefix}-role`, "Role or relationship (optional)", p.role, (v) => onChange({ role: v }), errorFor("role"), { hint: c.labels.roleHint })}
        {c.announced ? text(`${idPrefix}-pronunciation`, "Name pronunciation (optional)", p.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), {
          hint: `Only needed if the DJ or MC might need help pronouncing a name. ${PRONUNCIATION_HINT}`,
        }) : null}
        {c.announced ? text(`${idPrefix}-wording`, "How should they be announced? (optional)", p.wording, (v) => onChange({ wording: v }), errorFor("wording"), {
          rows: 2, hint: 'Only if you have particular wording in mind, for example "Please welcome, for the first time as a married couple…"',
        }) : null}
        {c.musicChoice ? (
          <div className="col-span-full">
            <Choices<EntryMusic>
              name={`${idPrefix}-music`}
              legend="Music (needed)"
              value={p.music}
              onChange={(v) => onChange(withMusic(p, (v || "undecided") as EntryMusic, (id) => c.groups.some((g) => g.songs.some((x) => x.id === id))))}
              error={errorFor("music")}
              options={[
                { value: "song", label: "Choose a song" },
                { value: "dj_choice", label: "DJ's choice" },
                { value: "undecided", label: "Not decided yet" },
              ]}
            />
          </div>
        ) : null}
        {c.musicChoice && p.music !== "song" ? null : <SongPicker
          id={`${idPrefix}-song`}
          label={c.labels.song}
          value={p.song_id}
          groups={c.groups}
          draft={draft}
          onSelect={(songId) => onChange({ song_id: songId })}
          onDraft={(d) => onChange({ new_song: d })}
          onUseDraft={listed ? () => onChange({ new_song: draft ? { ...draft, use: true } : null }) : undefined}
          sharedWith={c.people.filter((x) => x.id !== p.id && x.song_id && x.song_id === p.song_id).map((x) => x.names.trim() || "Unnamed")}
          sharedText={c.labels.shared}
          errorFor={songError}
          missingText={c.missing}
          hint={listed ? undefined : c.musicChoice ? "Pick a song already listed, or enter a new one." : "Pick a song already listed, enter a new one, or leave it for later."}
        />}
        {text(`${idPrefix}-notes`, c.labels.notes, p.notes, (v) => onChange({ notes: v }), errorFor("notes"), { rows: 2, hint: c.labels.notesHint })}
      </>
    );
  };
}

/** The songs list under the people: each linked song once, editable in one place, never removable while linked. */
function SongsUnderPeople({ props, title, intro, form, update, fieldError, readOnly, linked, linkedWhere, choices }: {
  props: Common<unknown>;
  title: string;
  intro: string;
  form: MusicForm;
  update: (changes: Partial<MusicForm>, clears?: string[]) => void;
  fieldError: { field: string; message: string } | null;
  readOnly: boolean;
  linked: Map<string, string[]>;
  linkedWhere: string;
  choices: boolean;
}) {
  return (
    <section className="grid gap-2 border-t pt-3" aria-label={title} data-testid={`music-${props.momentKey}`}>
      <h4 className="text-sm font-semibold">{title}</h4>
      <p data-plan-help className="text-xs text-muted-foreground">{intro}</p>
      <MusicSection
        itemId={props.itemId}
        momentKey={props.momentKey}
        label={props.label}
        editor="moment_songs"
        form={form}
        update={update}
        fieldError={fieldError}
        readOnly={readOnly}
        djName={props.djName}
        audience={props.audience}
        linked={linked}
        linkedWhere={linkedWhere}
        choices={choices}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Processional: who walks in, in order, each with their song
// ---------------------------------------------------------------------------

/**
 * The processional as couples think of it: who walks in, in order, and the
 * song each walks to, chosen or typed right with the person (SongPicker).
 * People and songs are one answer saved together, so a song and its link
 * are never saved apart. Several people can share a song; the songs list
 * below holds each song once, with the choice for the processional's music.
 * No pronunciation guide here: nobody is announced while walking in (older
 * guides are kept, and shown to staff).
 */
export function ProcessionalEditor(props: Common<ProcessionalAnswers>) {
  const readOnly = useEditingClosed(props.disabledReason);
  const songs = usePlanSongs();
  const { form, update, saveState, message, fieldError, retry } = useAutosave<ProcessionalForm, ProcessionalAnswers>({
    initialForm: processionalForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: processionalAnswersFromForm,
    save: props.save,
    readOnly,
    onSaved: (answers) => {
      songs?.setSongs(props.itemId, (answers as ProcessionalAnswers).songs ?? []);
      songs?.setProcessionalPeople((answers as ProcessionalAnswers).participants ?? []);
    },
  });
  const notApplicable = form.choice === "not_applicable";
  // Older plans may also have a Couple entrance moment: its songs can still be picked here.
  const couple = songs?.lists.find((l) => l.key === "couple_entrance");
  const groups: SongGroup[] = [
    { label: "Songs already in this processional", songs: songOptions(form.songs) },
    ...(couple ? [{ label: couple.label, songs: couple.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, cue: s.cue })) }] : []),
  ];
  const room = MUSIC_RULES.moment_songs.maxSongs - form.songs.length;
  const setParticipants = (participants: ProcessionalPersonForm[], clears?: string[]) => {
    const next = withNewSongs(form, participants);
    update({ participants: next.participants, songs: next.songs }, clears);
  };
  const people: SongPeople = {
    audience: props.audience,
    people: form.participants,
    groups,
    missing: "The linked song isn't in this processional's songs any more. It's kept; choose another song or none.",
    room,
    listName: "The processional",
    announced: false,
    musicChoice: false,
    labels: {
      names: "Name or names",
      namesHint: "As they should appear for the DJ; no particular titles needed.",
      roleHint: "For example: maid of honour, grandparents.",
      song: "Song they walk in to",
      shared: "Also walking to this song",
      notes: "Instructions for the DJ (optional)",
      notesHint: 'For example "keep the same song playing", "start the next song when they reach the front" or "wait for the doors to open".',
    },
  };

  return (
    <Frame
      props={props as Common<unknown>}
      hint="Add everyone who will walk down the aisle, in the order they'll enter. Include either partner, wedding party members, family or other participants. Choose each one's song as you add them; several people can walk to the same song."
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <section className="grid gap-2" aria-label="Who walks in" data-testid="processional-participants">
        <Choices<"discuss">
          name={`${props.momentKey}-participants-choice`}
          legend="Who walks in (needed)"
          value={form.participants_choice}
          disabled={readOnly || notApplicable}
          onChange={(v) => update({ participants_choice: v as "" | "discuss" }, ["participants_choice"])}
          error={fieldError?.field === "participants_choice" ? fieldError.message : null}
          options={[
            { value: "", label: "I'll list who walks in" },
            { value: "discuss", label: discussLabel(props.audience) },
          ]}
        />
        <p data-plan-help className="text-xs text-muted-foreground">
          One entry per person or group, in walking order, for example &ldquo;Alex with their mother, Dana&rdquo;, &ldquo;The bridesmaids&rdquo; or
          &ldquo;Sam and Jo&rdquo; if you walk in together. Someone already waiting at the front doesn&apos;t need an entry.
        </p>
        <EntryList<ProcessionalPersonForm>
          base={`${props.momentKey}-people`}
          noun="Person or group"
          entries={form.participants}
          setEntries={setParticipants}
          readOnly={readOnly}
          canAdd={!notApplicable}
          addBlockedText={notApplicable ? "This moment is marked as not happening." : undefined}
          max={30}
          nameOf={(p) => p.names.trim() || "Unnamed"}
          summary={songPersonSummary(people)}
          fields={songPersonFields(people)}
          newEntry={(id) => ({ ...emptyPerson(id), new_song: null })}
          check={(p) => checkPerson(p) ?? newSongProblem(p.new_song, room)}
          fieldError={fieldError}
        />
      </section>
      <SongsUnderPeople
        props={props as Common<unknown>}
        title="Processional songs"
        intro="Each song chosen above appears here once. Edit a song here to change it for everyone walking to it, or add a song for the processional as a whole. A song can't be removed while someone walks to it."
        form={form}
        update={(changes, clears) => update(changes, clears)}
        fieldError={fieldError}
        readOnly={readOnly}
        linked={linksBySong(form.participants)}
        linkedWhere="who walks in"
        choices
      />
    </Frame>
  );
}

const songOptions = (songs: SongForm[]) => songs.filter((s) => s.title.trim() && s.artist.trim()).map((s) => ({ id: s.id, title: s.title, artist: s.artist, cue: s.cue }));

// ---------------------------------------------------------------------------
// Reception introductions: the grand entrance order, each with their song
// ---------------------------------------------------------------------------

/**
 * Who is introduced at the reception, in order: names as announced, an
 * optional pronunciation and announcement, and the song each enters to,
 * chosen or typed right there (the Processional's pattern). Entries and the
 * grand entrance's own songs are one answer saved together. Older plans may
 * also have an Entrance music list, whose songs can still be picked.
 */
export function IntroductionsEditor(props: Common<IntroductionsAnswers>) {
  const readOnly = useEditingClosed(props.disabledReason);
  const songs = usePlanSongs();
  const { form, update, saveState, message, fieldError, retry } = useAutosave<IntroductionsForm, IntroductionsAnswers>({
    initialForm: introductionsForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: introductionsAnswersFromForm,
    save: props.save,
    readOnly,
    onSaved: (answers) => songs?.setIntroductions((answers as IntroductionsAnswers).entries ?? []),
  });
  const entrance = songs?.lists.find((l) => l.key === "entrance_music");
  const groups: SongGroup[] = [
    { label: "Songs already in this grand entrance", songs: songOptions(form.songs) },
    ...(entrance ? [{ label: entrance.label, songs: entrance.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, cue: s.cue })) }] : []),
  ];
  const room = MUSIC_RULES.moment_songs.maxSongs - form.songs.length;
  const listName = "The grand entrance";
  const setEntries = (entries: SongPersonForm[], clears?: string[]) => {
    const next = addNewSongs(form.songs, form.entries, entries);
    update({ entries: next.people, songs: next.songs }, clears);
  };
  const people: SongPeople = {
    audience: props.audience,
    people: form.entries,
    groups,
    missing: "The linked song isn't in the grand entrance songs any more. It's kept; choose another song or none.",
    room,
    listName,
    announced: true,
    musicChoice: true,
    labels: {
      names: "Names exactly as announced",
      namesHint: 'One person or a group, for example "The bridesmaids", "Our parents" or "Alex and Sam".',
      roleHint: "For example: maid of honour, the couple, grandparents.",
      song: "Song they enter to",
      shared: "Also entering to this song",
      notes: "Instructions for the DJ or MC (optional)",
      notesHint: 'For example "keep the same song playing", "wait until they reach the dance floor" or "pause for photos".',
    },
  };
  const blocked = form.entries.length > 0 ? "Remove the entries to choose this." : null;
  return (
    <Frame
      props={props as Common<unknown>}
      hint="Everyone who will be introduced, in the order they'll enter: the couple only, the wedding party, family, or whoever you like. Choose each one's song as you add them; several can enter to the same song."
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <Choices<ListChoice>
        name={`${props.momentKey}-choice`}
        legend="Who is introduced (needed)"
        value={form.choice}
        disabled={readOnly}
        onChange={(v) => update({ choice: v }, ["choice"])}
        error={fieldError?.field === "choice" ? fieldError.message : null}
        options={[
          { value: "", label: "I'll list who is introduced" },
          { value: "none", label: "Nobody will be introduced", blocked },
          { value: "discuss", label: discussLabel(props.audience) },
        ]}
      />
      <EntryList<SongPersonForm>
        base={`${props.momentKey}-entries`}
        noun="Person or group"
        entries={form.entries}
        setEntries={setEntries}
        readOnly={readOnly}
        canAdd={form.choice !== "none"}
        addBlockedText={'To add introductions, choose "I\'ll list who is introduced" above.'}
        max={40}
        nameOf={(p) => p.names.trim() || "Unnamed"}
        summary={songPersonSummary(people)}
        fields={songPersonFields(people)}
        newEntry={(id) => ({ ...emptyPerson(id), new_song: null })}
        check={(p) => checkPerson(p) ?? newSongProblem(p.new_song, room, listName)}
        fieldError={fieldError}
      />
      {form.songs.length > 0 ? (
        <SongsUnderPeople
          props={props as Common<unknown>}
          title="Grand entrance songs"
          intro="Each song chosen above appears here once. Edit a song here to change it for everyone entering to it. A song can't be removed while someone enters to it."
          form={{ songs: form.songs, choice: "" }}
          update={(changes, clears) => update(changes.songs ? { songs: changes.songs } : {}, clears)}
          fieldError={fieldError}
          readOnly={readOnly}
          linked={linksBySong(form.entries)}
          linkedWhere="the grand entrance order"
          choices={false}
        />
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Speeches and toasts
// ---------------------------------------------------------------------------

export function SpeechesEditor(props: Common<SpeechesAnswers> & { event: { date: string; timezone: string } }) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<SpeechesForm, SpeechesAnswers>({
    initialForm: speechesForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: speechesAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const nextDay = nextDayLabel(props.event.date);
  const timingText = (s: SpeechForm) =>
    s.timing === "time" && s.time ? `At ${s.time}${s.next_day ? ` (next day, ${nextDay})` : ""}`
    : s.timing === "cue" && s.cue.trim() ? s.cue.trim()
    : null;
  const blocked = form.entries.length > 0 ? "Remove the speeches to choose this." : null;
  return (
    <Frame
      props={props as Common<unknown>}
      hint={`Each speech counts once it has a speaker and a timing: an exact time (local to the event, ${zoneName(props.event.timezone)}) or a moment such as "After the main course".`}
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <Choices<ListChoice>
        name={`${props.momentKey}-choice`}
        legend="Your answer (needed)"
        value={form.choice}
        disabled={readOnly}
        onChange={(v) => update({ choice: v }, ["choice"])}
        error={fieldError?.field === "choice" ? fieldError.message : null}
        options={[
          { value: "", label: "I'll list the speeches" },
          { value: "none", label: "No speeches or toasts", blocked },
          { value: "discuss", label: discussLabel(props.audience) },
        ]}
      />
      <EntryList<SpeechForm>
        base={`${props.momentKey}-entries`}
        noun="Speech"
        entries={form.entries}
        setEntries={(entries, clears) => update({ entries }, clears)}
        readOnly={readOnly}
        canAdd={form.choice !== "none"}
        addBlockedText={'To add speeches, choose "I\'ll list the speeches" above.'}
        max={30}
        nameOf={(s) => s.speaker.trim() || "Unnamed speaker"}
        summary={(s, index) => {
          const when = timingText(s);
          return (
            <>
              <NameLine index={index} name={s.speaker} pronunciation={s.pronunciation} />
              {s.role.trim() ? <p className="text-xs text-plan-ink-2 [overflow-wrap:anywhere]">{s.role}</p> : null}
              <p className={when ? "text-xs text-plan-ink-2 [overflow-wrap:anywhere]" : "text-xs text-status-attention"}>
                {when ?? "Timing not decided yet"}
                {s.duration.trim() ? ` · about ${s.duration.trim()} min` : ""}
              </p>
              {s.av_notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Microphone / AV: {s.av_notes}</p> : null}
              {s.notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Instructions: {s.notes}</p> : null}
            </>
          );
        }}
        fields={(s, onChange, errorFor, idPrefix) => (
          <>
            {text(`${idPrefix}-speaker`, "Speaker", s.speaker, (v) => onChange({ speaker: v }), errorFor("speaker"))}
            {text(`${idPrefix}-role`, "Role or relationship (optional)", s.role, (v) => onChange({ role: v }), errorFor("role"))}
            {text(`${idPrefix}-pronunciation`, "Pronunciation guide (optional)", s.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT, wide: true })}
            <Choices<Timing>
              name={`${idPrefix}-timing`}
              legend="When (needed to complete)"
              value={s.timing}
              onChange={(v) => onChange({ timing: (v || "undecided") as Timing })}
              error={errorFor("timing")}
              options={[{ value: "time", label: "At an exact time" }, { value: "cue", label: "At a moment in the evening" }, { value: "undecided", label: "Not decided yet" }]}
            />
            {s.timing === "time" ? (
              <TimeField id={`${idPrefix}-time`} label="Time" time={s.time} nextDay={s.next_day} eventDate={props.event.date}
                onTime={(t) => onChange({ time: t })} onNextDay={(n) => onChange({ next_day: n })} error={errorFor("time")} />
            ) : null}
            {s.timing === "cue" ? text(`${idPrefix}-cue`, "Moment", s.cue, (v) => onChange({ cue: v }), errorFor("cue"), { hint: 'For example "After the main course" or "Right after the first dance".', wide: true }) : null}
            <FieldBox id={`${idPrefix}-duration`} label="About how long, in minutes (optional)" error={errorFor("duration")}>
              <Input id={`${idPrefix}-duration`} inputMode="numeric" autoComplete="off" className="w-36" value={s.duration} onChange={(e) => onChange({ duration: e.target.value })} />
            </FieldBox>
            {text(`${idPrefix}-av_notes`, "Microphone or AV notes (optional)", s.av_notes, (v) => onChange({ av_notes: v }), errorFor("av_notes"), { rows: 2, hint: EQUIPMENT_NOTE })}
            {text(`${idPrefix}-notes`, "Other instructions (optional)", s.notes, (v) => onChange({ notes: v }), errorFor("notes"), { rows: 2 })}
          </>
        )}
        newEntry={emptySpeech}
        check={(s) => (s.speaker.trim() ? null : { field: "speaker", message: "Enter the speaker's name." })}
        fieldError={fieldError}
      />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// MC
// ---------------------------------------------------------------------------

/**
 * Who handles MC duties: the DJ, someone else, or both sharing them. The DJ
 * option names the DJ handling the event when one is configured. "No MC" is
 * no longer offered; a saved one is still shown, selected, until changed.
 * No pronunciation guide is asked; an earlier one is kept and shown to staff.
 */
export function McEditor(props: Common<McAnswers>) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<McForm, McAnswers>({
    initialForm: mcForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: mcAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const id = (f: string) => `${props.momentKey}-${f}`;
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const client = props.audience === "client";
  const dj = djIdentity(props.djDisplayName, props.audience);
  const legacyNone = props.initialAnswers.mc === "none" || form.mc === "none";
  return (
    <Frame props={props as Common<unknown>} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      <Choices<McChoice>
        name={id("mc")}
        legend="Who will handle MC duties during the reception? (needed)"
        value={form.mc}
        disabled={readOnly}
        onChange={(v) => update({ mc: v }, ["mc"])}
        error={errorFor("mc")}
        options={[
          { value: "dj", label: `${dj} will be the MC` },
          { value: "other", label: "Someone else will be the MC" },
          { value: "shared", label: `${dj} and another MC will share duties` },
          { value: "discuss", label: discussLabel(props.audience) },
          ...(legacyNone ? [{ value: "none" as const, label: "No MC", hint: "An earlier answer that is no longer offered. Choose another option to update it." }] : []),
        ]}
      />
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">MC details</legend>
        {hasOtherMc(form.mc) ? (
          <>
            {text(id("name"), "MC's name (needed)", form.name, (v) => update({ name: v }, ["name"]), errorFor("name"),
              form.mc === "shared" ? { hint: `The person sharing MC duties with ${djRef(props.audience)}.` } : {})}
            {text(id("contact"), "Phone or email (optional)", form.contact, (v) => update({ contact: v }, ["contact"]), errorFor("contact"), { hint: "Only for coordinating on the day." })}
            {!client && form.pronunciation.trim() ? (
              <p className="col-span-full text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="mc-earlier-pronunciation">
                Pronunciation guide (earlier answer, no longer asked): {form.pronunciation.trim()}
              </p>
            ) : null}
          </>
        ) : null}
        {text(id("notes"), "Instructions (optional)", form.notes, (v) => update({ notes: v }, ["notes"]), errorFor("notes"), { rows: 2, hint: "For example: bilingual announcements, who hands over to whom." })}
      </fieldset>
    </Frame>
  );
}

