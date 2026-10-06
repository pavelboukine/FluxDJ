"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyPerson,
  emptySpeech,
  entryField,
  introductionsAnswersFromForm,
  introductionsForm,
  linksBySong,
  mcAnswersFromForm,
  mcForm,
  processionalAnswersFromForm,
  processionalForm,
  songLabel,
  speechesAnswersFromForm,
  speechesForm,
  type IntroductionsAnswers,
  type IntroductionsForm,
  type ListChoice,
  type McAnswers,
  type McForm,
  type PersonForm,
  type ProcessionalAnswers,
  type ProcessionalForm,
  type SpeechForm,
  type SpeechesAnswers,
  type SpeechesForm,
  type Timing,
} from "@/lib/planning/participants";
import { EQUIPMENT_NOTE, nextDayLabel } from "@/lib/planning/stages";
import type { SaveItemResult } from "@/lib/planning/view";
import { FieldBox } from "./basics-editor";
import { MusicSection, usePlanSongs } from "./music-editor";
import { ItemChecklist, useEditingClosed } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

const newId = () => crypto.randomUUID();

export type Common<A> = {
  itemId: string;
  momentKey: string;
  label: string;
  initialAnswers: A;
  initialRevision: number;
  djName: string;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: A) => Promise<SaveItemResult>;
  disabledReason?: string;
};

export function Frame({ props, hint, children, status }: { props: Common<unknown>; hint?: ReactNode; children: ReactNode; status: ReactNode }) {
  return (
    <div className="grid gap-3" data-testid={`editor-${props.momentKey}`}>
      <ItemChecklist itemId={props.itemId} title={props.label} djName={props.djName} audience={props.audience} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      {children}
      {props.disabledReason ? null : status}
    </div>
  );
}

export function Choices<C extends string>({ name, legend, value, options, onChange, error, disabled }: {
  name: string;
  legend: string;
  value: C | "";
  options: { value: C | ""; label: string; blocked?: string | null }[];
  onChange: (value: C | "") => void;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="grid gap-1">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {options.map((o) => (
        <label key={o.value || "list"} className="flex min-h-9 items-start gap-2 text-sm">
          <input type="radio" name={name} className="mt-0.5 size-4 accent-primary" checked={value === o.value} disabled={Boolean(o.blocked)} onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            {o.blocked ? <span className="block text-xs text-muted-foreground">{o.blocked}</span> : null}
          </span>
        </label>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </fieldset>
  );
}

/** "Name (pronunciation)". The guide sits beside the name, as typed. */
function NameLine({ index, name, pronunciation }: { index: number; name: string; pronunciation: string }) {
  return (
    <p className="font-medium [overflow-wrap:anywhere]">
      {index + 1}. {name.trim() || "Unnamed"}
      {pronunciation.trim() ? <span className="font-normal text-muted-foreground"> (say: {pronunciation.trim()})</span> : null}
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
  const clears = (id: string) => ["entries", ...["names", "role", "pronunciation", "wording", "notes", "song_id", "speaker", "timing", "time", "next_day", "cue", "duration", "av_notes", "name", "business", "phone", "email", "title", "recipient", "presenter", "host", "participants", "relationship", "message", "song_title", "song_artist", "song_version", "song_link"].map((f) => entryField(id, f))];
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
    <div className="grid gap-2">
      {entries.length > 0 ? (
        <ol className="grid gap-2" aria-label={`${props.noun}s`}>
          {entries.map((e, index) => {
            const name = props.nameOf(e);
            const hasError = props.fieldError?.field.startsWith(`entry:${e.id}:`);
            return (
              <li key={e.id} className="grid gap-2 rounded-lg border p-3" data-testid="entry-row">
                <div className="grid min-w-0 gap-0.5">{props.summary(e, index)}</div>
                {!props.readOnly ? (
                  <div className="flex flex-wrap gap-1">
                    <Button type="button" size="sm" variant="outline" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move "${name}" up`}>Move up</Button>
                    <Button type="button" size="sm" variant="outline" disabled={index === entries.length - 1} onClick={() => move(index, 1)} aria-label={`Move "${name}" down`}>Move down</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditing(editing === e.id ? null : e.id)} aria-expanded={editing === e.id} aria-label={`${editing === e.id ? "Done editing" : "Edit"} "${name}"`}>
                      {editing === e.id ? "Done" : "Edit"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => remove(index)} aria-label={`Remove "${name}"`}>Remove</Button>
                  </div>
                ) : null}
                {editing === e.id || hasError ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {props.fields(e, (changes) => setEntries(entries.map((x) => (x.id === e.id ? { ...x, ...changes } : x)), clears(e.id)), errorFor(e.id), `${props.base}-${e.id}`)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {removed ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm">
          Removed &ldquo;{props.nameOf(removed.entry)}&rdquo;.
          <Button type="button" size="sm" variant="outline" onClick={undo}>Undo</Button>
        </p>
      ) : null}
      {props.readOnly ? null : !props.canAdd ? (
        props.addBlockedText ? <p className="text-xs text-muted-foreground">{props.addBlockedText}</p> : null
      ) : entries.length >= props.max ? (
        <p className="text-xs text-muted-foreground">This list has the maximum of {props.max} entries.</p>
      ) : (
        <details className="rounded-lg border p-3" data-testid={`${props.base}-add`}>
          <summary className="cursor-pointer text-sm font-medium">Add {props.noun.toLowerCase()}</summary>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {props.fields(draft, (changes) => { setDraft((d) => ({ ...d, ...changes })); setDraftError(null); }, (field) => (draftError?.field === field ? draftError.message : null), `${props.base}-new`)}
            </div>
            <Button type="button" size="sm" className="w-fit" onClick={add}>Add</Button>
          </div>
        </details>
      )}
      {props.fieldError?.field === "entries" ? <p role="alert" className="text-xs text-destructive">{props.fieldError.message}</p> : null}
    </div>
  );
}

export const text = (id: string, label: string, value: string, onChange: (v: string) => void, error: string | null, opts: { hint?: string; rows?: number; wide?: boolean } = {}) => (
  <FieldBox key={id} id={id} label={label} error={error} hint={opts.hint} className={opts.rows || opts.wide ? "sm:col-span-2" : undefined}>
    {opts.rows ? (
      <Textarea id={id} rows={opts.rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />
    ) : (
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />
    )}
  </FieldBox>
);

export const PRONUNCIATION_HINT = 'Written as it sounds, for example "ah-LEK-sah DOO-bwah".';

/** A song picker over one source list; an id it doesn't list is shown as not in the active plan. */
function SongSelect({ id, value, songs, onChange, error, missingText }: {
  id: string;
  value: string;
  songs: { id: string; title: string; artist: string; cue?: string }[];
  onChange: (v: string) => void;
  error: string | null;
  missingText: string;
}) {
  const missing = value !== "" && !songs.some((s) => s.id === value);
  return (
    <FieldBox id={id} label="Song (optional)" error={error} hint={missing ? missingText : songs.length === 0 ? "Add songs to the list first to pick one here." : undefined} className="sm:col-span-2">
      <select id={id} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No song</option>
        {missing ? <option value={value}>Linked song not in the active plan</option> : null}
        {songs.map((s) => <option key={s.id} value={s.id}>{songLabel(s)}</option>)}
      </select>
    </FieldBox>
  );
}

function personFields(opts: { wording: boolean; songs: { id: string; title: string; artist: string; cue?: string }[]; missingText: string; namesLabel: string; namesHint: string }) {
  return function renderPersonFields(p: PersonForm, onChange: (c: Partial<PersonForm>) => void, errorFor: (f: string) => string | null, idPrefix: string) {
    return (
    <>
      {text(`${idPrefix}-names`, opts.namesLabel, p.names, (v) => onChange({ names: v }), errorFor("names"), { hint: opts.namesHint, wide: true })}
      {text(`${idPrefix}-role`, "Role or relationship (optional)", p.role, (v) => onChange({ role: v }), errorFor("role"))}
      {text(`${idPrefix}-pronunciation`, "Pronunciation guide (optional)", p.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT })}
      {opts.wording ? text(`${idPrefix}-wording`, "Introduction wording (optional)", p.wording, (v) => onChange({ wording: v }), errorFor("wording"), { rows: 2, hint: 'For example "Please welcome, for the first time as a married couple…"' }) : null}
      {text(`${idPrefix}-notes`, "Instructions (optional)", p.notes, (v) => onChange({ notes: v }), errorFor("notes"), { rows: 2 })}
      <SongSelect id={`${idPrefix}-song`} value={p.song_id} songs={opts.songs} onChange={(v) => onChange({ song_id: v })} error={errorFor("song_id")} missingText={opts.missingText} />
    </>
    );
  };
}

function personSummary(songs: { id: string; title: string; artist: string; cue?: string }[], missingText: string, opts: { wording: boolean }) {
  return function renderPersonSummary(p: PersonForm, index: number) {
    const song = songs.find((s) => s.id === p.song_id);
    return (
      <>
        <NameLine index={index} name={p.names} pronunciation={p.pronunciation} />
        {p.role.trim() ? <p className="text-xs [overflow-wrap:anywhere]">{p.role}</p> : null}
        {opts.wording && p.wording.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Wording: {p.wording}</p> : null}
        {p.notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Instructions: {p.notes}</p> : null}
        {p.song_id ? (
          song ? <p className="text-xs [overflow-wrap:anywhere]">Song: {songLabel(song)}</p> : <p className="text-xs text-amber-700 dark:text-amber-400">{missingText}</p>
        ) : null}
      </>
    );
  };
}

const checkPerson = (p: PersonForm) => (p.names.trim() ? null : { field: "names", message: "Enter the name or names." });

// ---------------------------------------------------------------------------
// Processional: its songs, then who walks in
// ---------------------------------------------------------------------------

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
  // This moment's songs, then Couple entrance's (same ceremony): the couple's own entry can use its song.
  const couple = songs?.lists.find((l) => l.key === "couple_entrance");
  const songList = [
    ...form.songs.filter((s) => s.title.trim() && s.artist.trim()).map((s) => ({ id: s.id, title: s.title, artist: s.artist, cue: s.cue })),
    ...(couple?.songs ?? []).map((s) => ({ ...s, cue: `${couple!.label}${s.cue ? `, ${s.cue}` : ""}` })),
  ];
  const missing = couple
    ? "The linked song isn't in Processional or Couple entrance any more. Choose another song or none."
    : "The linked song isn't in the active plan (Couple entrance is hidden). It's kept; choose another song or none.";
  return (
    <Frame
      props={props as Common<unknown>}
      hint="Songs for the processional and who walks in, in order, the couple included. The couple's own song goes under Couple entrance and can be picked for their entry here."
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <div data-testid={`music-${props.momentKey}`}>
        <MusicSection
          itemId={props.itemId}
          momentKey={props.momentKey}
          label={props.label}
          editor="moment_songs"
          form={form}
          update={(changes, clears) => update(changes, clears)}
          fieldError={fieldError}
          readOnly={readOnly}
          djName={props.djName}
          audience={props.audience}
          linked={linksBySong(form.participants)}
          linkedWhere="Who walks in"
        />
      </div>
      <section className="grid gap-2 border-t pt-3" aria-label="Who walks in" data-testid="processional-participants">
        <Choices<"discuss">
          name={`${props.momentKey}-participants-choice`}
          legend="Who walks in (needed)"
          value={form.participants_choice}
          disabled={readOnly || notApplicable}
          onChange={(v) => update({ participants_choice: v as "" | "discuss" }, ["participants_choice"])}
          error={fieldError?.field === "participants_choice" ? fieldError.message : null}
          options={[
            { value: "", label: "I'll list who walks in" },
            { value: "discuss", label: `Not sure yet, discuss with ${props.audience === "client" ? props.djName : "the DJ"}` },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          One entry per person or group, in walking order, for example &ldquo;Alex with their mother, Dana&rdquo; or &ldquo;Sam and Jo&rdquo;. Each can
          have one of the songs above or the Couple entrance song.
        </p>
        <EntryList<PersonForm>
          base={`${props.momentKey}-people`}
          noun="Person or group"
          entries={form.participants}
          setEntries={(participants, clears) => update({ participants }, clears)}
          readOnly={readOnly}
          canAdd={!notApplicable}
          addBlockedText={notApplicable ? "This moment is marked as not happening." : undefined}
          max={30}
          nameOf={(p) => p.names.trim() || "Unnamed"}
          summary={personSummary(songList, missing, { wording: false })}
          fields={personFields({ wording: false, songs: songList, missingText: missing, namesLabel: "Name or names", namesHint: "As they should appear for the DJ; no particular titles needed." })}
          newEntry={emptyPerson}
          check={checkPerson}
          fieldError={fieldError}
        />
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Reception introductions (songs come from Entrance music)
// ---------------------------------------------------------------------------

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
  const songList = entrance?.songs ?? [];
  const missing = entrance
    ? "The linked song isn't in Entrance music any more. Choose another song or none."
    : "The linked song isn't in the active plan (Entrance music is hidden). It's kept; choose another song or none.";
  const blocked = form.entries.length > 0 ? "Remove the entries to choose this." : null;
  return (
    <Frame
      props={props as Common<unknown>}
      hint="Everyone announced at the reception entrance, in order, with names exactly as they should be said. Songs come from Entrance music; several entries can share one."
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
          { value: "", label: "I'll list them" },
          { value: "none", label: "No introductions", blocked },
          { value: "discuss", label: `Not sure yet, discuss with ${props.audience === "client" ? props.djName : "the DJ"}` },
        ]}
      />
      <EntryList<PersonForm>
        base={`${props.momentKey}-entries`}
        noun="Introduction"
        entries={form.entries}
        setEntries={(entries, clears) => update({ entries }, clears)}
        readOnly={readOnly}
        canAdd={form.choice !== "none"}
        addBlockedText={'To add introductions, choose "I\'ll list them" above.'}
        max={40}
        nameOf={(p) => p.names.trim() || "Unnamed"}
        summary={personSummary(songList, missing, { wording: true })}
        fields={personFields({ wording: true, songs: songList, missingText: missing, namesLabel: "Names exactly as announced", namesHint: 'One person or a group, for example "The wedding party" or "Alex and Sam".' })}
        newEntry={emptyPerson}
        check={checkPerson}
        fieldError={fieldError}
      />
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
      hint={`Each speech counts once it has a speaker and a timing: an exact time (local to the event, ${props.event.timezone}) or a moment such as "After the main course".`}
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
          { value: "discuss", label: `Not sure yet, discuss with ${props.audience === "client" ? props.djName : "the DJ"}` },
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
              {s.role.trim() ? <p className="text-xs [overflow-wrap:anywhere]">{s.role}</p> : null}
              <p className={when ? "text-xs [overflow-wrap:anywhere]" : "text-xs text-amber-700 dark:text-amber-400"}>
                {when ?? "Timing not decided yet"}
                {s.duration.trim() ? ` · about ${s.duration.trim()} min` : ""}
              </p>
              {s.av_notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Microphone / AV: {s.av_notes}</p> : null}
              {s.notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Instructions: {s.notes}</p> : null}
            </>
          );
        }}
        fields={(s, onChange, errorFor, idPrefix) => (
          <>
            {text(`${idPrefix}-speaker`, "Speaker", s.speaker, (v) => onChange({ speaker: v }), errorFor("speaker"))}
            {text(`${idPrefix}-role`, "Role or relationship (optional)", s.role, (v) => onChange({ role: v }), errorFor("role"))}
            {text(`${idPrefix}-pronunciation`, "Pronunciation guide (optional)", s.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT, wide: true })}
            <fieldset className="grid gap-1 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">When (needed to complete)</legend>
              {([["time", "At an exact time"], ["cue", "At a moment in the evening"], ["undecided", "Not decided yet"]] as [Timing, string][]).map(([value, label]) => (
                <label key={value} className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="radio" name={`${idPrefix}-timing`} className="size-4 accent-primary" checked={s.timing === value} onChange={() => onChange({ timing: value })} />
                  {label}
                </label>
              ))}
              {errorFor("timing") ? <p className="text-xs text-destructive">{errorFor("timing")}</p> : null}
            </fieldset>
            {s.timing === "time" ? (
              <FieldBox id={`${idPrefix}-time`} label="Time" error={errorFor("time")} className="sm:col-span-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Input id={`${idPrefix}-time`} type="time" className="w-36" value={s.time} onChange={(e) => onChange({ time: e.target.value })} aria-invalid={Boolean(errorFor("time"))} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4 accent-primary" checked={s.next_day} disabled={s.time === ""} onChange={(e) => onChange({ next_day: e.target.checked })} />
                    Next day ({nextDay})
                  </label>
                </div>
              </FieldBox>
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
  const dj = props.audience === "client" ? props.djName : "the DJ";
  return (
    <Frame props={props as Common<unknown>} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      <Choices<"dj" | "other" | "none" | "discuss">
        name={id("mc")}
        legend="Who is the MC? (needed)"
        value={form.mc}
        disabled={readOnly}
        onChange={(v) => update({ mc: v }, ["mc"])}
        error={errorFor("mc")}
        options={[
          { value: "dj", label: props.audience === "client" ? `${props.djName} (the DJ)` : "The DJ" },
          { value: "other", label: "Someone else" },
          { value: "none", label: "No MC" },
          { value: "discuss", label: `Not sure yet, discuss with ${dj}` },
        ]}
      />
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">MC details</legend>
        {form.mc === "other" ? (
          <>
            {text(id("name"), "MC's name (needed)", form.name, (v) => update({ name: v }, ["name"]), errorFor("name"))}
            {text(id("pronunciation"), "Pronunciation guide (optional)", form.pronunciation, (v) => update({ pronunciation: v }, ["pronunciation"]), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT })}
            {text(id("contact"), "Phone or email (optional)", form.contact, (v) => update({ contact: v }, ["contact"]), errorFor("contact"), { hint: "Only for coordinating on the day.", wide: true })}
          </>
        ) : null}
        {text(id("notes"), "Instructions (optional)", form.notes, (v) => update({ notes: v }, ["notes"]), errorFor("notes"), { rows: 2, hint: "For example: bilingual announcements, who hands over to whom." })}
      </fieldset>
    </Frame>
  );
}

