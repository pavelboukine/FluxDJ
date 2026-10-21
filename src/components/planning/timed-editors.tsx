"use client";

import { useState, type ReactNode } from "react";
import { Plus, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ListChoice } from "@/lib/planning/participants";
import { minutesOf, nextDayLabel } from "@/lib/planning/stages";
import {
  ACTIVITY_SUGGESTIONS,
  TIMED_RULES,
  arrivalAnswersFromForm,
  arrivalForm,
  emptyTimedEntry,
  programAnswersFromForm,
  programForm,
  timedAnswersFromForm,
  timedEntryProblem,
  timedForm,
  type ArrivalAnswers,
  type ArrivalForm,
  type ProgramForm,
  type TimedAnswers,
  type TimedEditor,
  type TimedEntryForm,
  type TimedForm,
  type Timing,
} from "@/lib/planning/timed";
import { isHttpsUrl, linkHost } from "@/lib/payments";
import { FieldBox } from "./basics-editor";
import { SongFields } from "./song-fields";
import { TimeField } from "./time-field";
import { Choices, EntryList, Frame, PRONUNCIATION_HINT, text, type Common } from "./participants-editor";
import { ChoiceFieldset, ChoiceOption, ChoiceSingle } from "./choice-list";
import { LabelText } from "./label-text";
import { useEditingClosed, usePlanProgress } from "./progress";
import { zoneName } from "@/lib/planning/cutoff";
import { discussLabel } from "@/lib/planning/dj";
import { SaveStatus, useAutosave } from "./use-autosave";

type EventInfo = { date: string; timezone: string; venueName: string | null; venueAddress: string | null };

/** An end at or before its start: offer "Next day" for it (never assumed). */
function endNotAfterStart(form: { start_time: string; start_next_day: boolean; end_time: string; end_next_day: boolean }): boolean {
  const start = minutesOf(form, "start");
  const end = minutesOf(form, "end");
  return start !== null && end !== null && end <= start;
}

// ---------------------------------------------------------------------------
// Arrival details
// ---------------------------------------------------------------------------

export function ArrivalEditor(props: Common<ArrivalAnswers> & { event: EventInfo; ceremony: Record<string, unknown> | null }) {
  const readOnly = useEditingClosed(props.disabledReason);
  const plan = usePlanProgress();
  const { form, update, saveState, message, fieldError, retry } = useAutosave<ArrivalForm, ArrivalAnswers>({
    initialForm: arrivalForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: arrivalAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const id = (f: string) => `${props.momentKey}-${f}`;
  const venue = props.event.venueName ? `${props.event.venueName}${props.event.venueAddress ? `, ${props.event.venueAddress}` : ""}` : plan?.basics.venue_details ?? null;
  const c = props.ceremony;
  const ceremonyPlace = !c ? null : c.location_source === "event_venue" ? (venue ? `the event venue (${venue})` : "the event venue") : c.location_source === "other" && c.location_other ? String(c.location_other) : null;
  const ceremonyArrival = c?.guest_arrival_time ? `${c.guest_arrival_time}${c.guest_arrival_next_day ? ", next day" : ""}` : null;
  const none = form.arrival_none;
  const radio = (field: "location_source" | "time_source", value: string, label: string) => (
    <ChoiceOption key={value} name={id(field)} checked={form[field] === value} disabled={none}
      onChange={() => update({ [field]: value } as Partial<ArrivalForm>, [field, "arrival_none"])} label={label} />
  );
  return (
    <Frame
      props={props as Common<unknown>}
      hint={`General guest arrival, before anything else. Ceremony guest arrival stays in the Ceremony details; reuse it here instead of typing it twice. Times are local to the event (${zoneName(props.event.timezone)}). Arrival music has its own card.`}
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Arrival details</legend>
        <ChoiceSingle checked={none} onChange={(checked) => update({ arrival_none: checked }, ["arrival_none"])} label="No separate arrival arrangements" />
        {errorFor("arrival_none") ? <p className="text-xs text-destructive col-span-full">{errorFor("arrival_none")}</p> : null}
        <ChoiceFieldset
          legend="Where do guests arrive? (needed)"
          className="col-span-full"
          after={
            <>
              {form.location_source === "other" ? text(id("location_other"), "Place and address", form.location_other, (v) => update({ location_other: v }, ["location_other"]), errorFor("location_other"), { rows: 2 }) : null}
              {text(id("location_area"), "Room or outdoor area (optional)", form.location_area, (v) => update({ location_area: v }, ["location_area"]), errorFor("location_area"))}
            </>
          }
        >
          {radio("location_source", "event_venue", `Same as the event venue${venue ? ` (${venue})` : " (not entered yet)"}`)}
          {radio("location_source", "ceremony", `Same as the ceremony${ceremonyPlace ? ` (${ceremonyPlace})` : " (not in the Ceremony details yet)"}`)}
          {radio("location_source", "other", "Somewhere else")}
        </ChoiceFieldset>
        <ChoiceFieldset
          legend="When do guests arrive? (needed)"
          className="col-span-full"
          after={form.time_source === "time" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TimeField id={id("start_time")} label="Arrival starts (needed)" time={form.start_time} nextDay={form.start_next_day} eventDate={props.event.date}
                  onTime={(t) => update({ start_time: t }, ["start_time", "end_time"])} onNextDay={(n) => update({ start_next_day: n }, ["start_time", "end_time"])}
                  error={errorFor("start_time")} />
                <TimeField id={id("end_time")} label="Arrival ends (optional)" time={form.end_time} nextDay={form.end_next_day} eventDate={props.event.date}
                  onTime={(t) => update({ end_time: t }, ["end_time"])} onNextDay={(n) => update({ end_next_day: n }, ["end_time"])}
                  error={errorFor("end_time")} suggestNextDay={endNotAfterStart(form)} />
              </div>
            </>
          ) : null}
        >
          {radio("time_source", "ceremony", `Same as the ceremony's guest arrival${ceremonyArrival ? ` (${ceremonyArrival})` : " (not in the Ceremony details yet)"}`)}
          {radio("time_source", "time", "At a specific time")}
        </ChoiceFieldset>
        {text(id("welcome"), "Welcome instructions (optional)", form.welcome, (v) => update({ welcome: v }, ["welcome"]), errorFor("welcome"), { rows: 2, hint: "For example: welcome drinks on the terrace, light background music." })}
        {text(id("announcement"), "Announcement wording (optional)", form.announcement, (v) => update({ announcement: v }, ["announcement"]), errorFor("announcement"), { rows: 2 })}
      </fieldset>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Timed entries (agenda, activities, dedications)
// ---------------------------------------------------------------------------

const TIMING_LABELS: Record<Timing, string> = {
  anytime: "Any time during the party",
  time: "At an exact time",
  cue: "At a moment in the evening",
  undecided: "Not decided yet",
};

const WORDING: Record<TimedEditor, { noun: string; none: string; list: string; name: string; nameHint?: string; hint: string }> = {
  program: { noun: "Agenda item", none: "No formal program", list: "I'll list the agenda", name: "Title", hint: "Speeches and toasts have their own card; list the rest of the program here." },
  activities: {
    noun: "Activity", none: "No activities", list: "I'll list them", name: "Activity", nameHint: "Pick a suggestion or type your own, such as a cultural tradition.",
    hint: "Cake cutting, special dances and speeches have their own cards.",
  },
  dedications: { noun: "Dedication", none: "No dedications", list: "I'll list them", name: "For whom", nameHint: "A person or a group, for example \"Our grandparents\".", hint: "Each dedication needs a song and a timing to be complete." },
};

function timingText(e: TimedEntryForm, eventDate: string): string | null {
  if (e.timing === "anytime") return "Any time during the party";
  if (e.timing === "time" && e.time) return `At ${e.time}${e.next_day ? ` (next day, ${nextDayLabel(eventDate)})` : ""}`;
  if (e.timing === "cue" && e.cue.trim()) return e.cue.trim();
  return null;
}

function TimedList(props: {
  editor: TimedEditor;
  base: string;
  form: TimedForm;
  update: (changes: Partial<TimedForm>, clears?: string[]) => void;
  fieldError: { field: string; message: string } | null;
  readOnly: boolean;
  eventDate: string;
  audience: "client" | "staff";
}) {
  const { editor, form, update } = props;
  const rules = TIMED_RULES[editor];
  const w = WORDING[editor];
  const nameField = rules.name as keyof TimedEntryForm;
  const blocked = form.entries.length > 0 ? "Remove the entries to choose this." : null;
  // Activities ask no pronunciation guide (older guides are kept, and shown to staff).
  const asksPronunciation = editor !== "activities";
  return (
    <>
      <Choices<ListChoice>
        name={`${props.base}-choice`}
        legend="Your answer (needed)"
        value={form.choice}
        disabled={props.readOnly}
        onChange={(v) => update({ choice: v }, ["choice"])}
        error={props.fieldError?.field === "choice" ? props.fieldError.message : null}
        options={[
          { value: "", label: w.list },
          { value: "none", label: w.none, blocked },
          { value: "discuss", label: discussLabel(props.audience) },
        ]}
      />
      {editor === "activities" ? (
        <datalist id={`${props.base}-suggestions`}>{ACTIVITY_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist>
      ) : null}
      <EntryList<TimedEntryForm>
        base={`${props.base}-entries`}
        noun={w.noun}
        entries={form.entries}
        setEntries={(entries, clears) => update({ entries }, clears)}
        readOnly={props.readOnly}
        canAdd={form.choice !== "none"}
        addBlockedText={`To add entries, choose "${w.list}" above.`}
        max={40}
        nameOf={(e) => String(e[nameField]).trim() || "Unnamed"}
        summary={(e, index) => {
          const when = timingText(e, props.eventDate);
          const songMissing = rules.requiresSong && !(e.song_title.trim() && e.song_artist.trim());
          const who = [e.presenter, e.host, e.participants, e.relationship].map((x) => x.trim()).filter(Boolean).join(" · ");
          return (
            <>
              <p className="text-[0.9375rem] leading-snug font-medium [overflow-wrap:anywhere]">
                <span className="font-normal text-plan-ink-2 tabular-nums">{index + 1}. </span>{String(e[nameField]).trim() || "Unnamed"}
                {e.pronunciation.trim() && (asksPronunciation || props.audience === "staff") ? <span className="font-normal text-plan-ink-2"> (say: {e.pronunciation.trim()})</span> : null}
              </p>
              {who ? <p className="text-xs text-plan-ink-2 [overflow-wrap:anywhere]">{who}</p> : null}
              <p className={when ? "text-xs text-plan-ink-2" : "text-xs text-status-attention"}>
                {when ?? "Timing not decided yet"}{rules.duration && e.duration.trim() ? ` · about ${e.duration.trim()} min` : ""}
              </p>
              {rules.song ? (
                e.song_title.trim() ? (
                  <p className="text-xs [overflow-wrap:anywhere]">
                    <Music aria-hidden className="mr-1.5 inline size-3.5 -translate-y-px text-brand-ink" />
                    Song: {e.song_title} by {e.song_artist}{e.song_version.trim() ? ` (${e.song_version.trim()})` : ""}
                    {e.song_link.trim() && isHttpsUrl(e.song_link.trim()) ? (
                      <> · <a className="underline underline-offset-2" href={e.song_link.trim()} target="_blank" rel="noopener noreferrer nofollow">Open link ({linkHost(e.song_link.trim())})</a></>
                    ) : null}
                  </p>
                ) : songMissing ? <p className="text-xs text-status-attention">Song not chosen yet</p> : null
              ) : null}
              {e.message.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Message: {e.message}</p> : null}
              {e.notes.trim() ? <p className="whitespace-pre-line text-xs text-plan-ink-2 [overflow-wrap:anywhere]">Instructions: {e.notes}</p> : null}
            </>
          );
        }}
        fields={(e, onChange, errorFor, prefix) => (
          <>
            <FieldBox id={`${prefix}-${rules.name}`} label={w.name} error={errorFor(rules.name)} hint={w.nameHint} className="col-span-full">
              <Input id={`${prefix}-${rules.name}`} list={editor === "activities" ? `${props.base}-suggestions` : undefined} value={String(e[nameField])}
                onChange={(ev) => onChange({ [rules.name]: ev.target.value } as Partial<TimedEntryForm>)} aria-invalid={Boolean(errorFor(rules.name))} />
            </FieldBox>
            {editor === "program" ? text(`${prefix}-presenter`, "Presenter (optional)", e.presenter, (v) => onChange({ presenter: v }), errorFor("presenter")) : null}
            {editor === "activities" ? text(`${prefix}-host`, "Host (optional)", e.host, (v) => onChange({ host: v }), errorFor("host")) : null}
            {editor === "activities" ? text(`${prefix}-participants`, "Participants (optional)", e.participants, (v) => onChange({ participants: v }), errorFor("participants")) : null}
            {editor === "dedications" ? text(`${prefix}-relationship`, "Relationship (optional)", e.relationship, (v) => onChange({ relationship: v }), errorFor("relationship")) : null}
            {asksPronunciation ? text(`${prefix}-pronunciation`, "Pronunciation guide (optional)", e.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT }) : null}
            <div className="col-span-full">
              <Choices<Timing>
                name={`${prefix}-timing`}
                legend="When (needed to complete)"
                value={e.timing}
                onChange={(v) => onChange({ timing: (v || "undecided") as Timing })}
                error={errorFor("timing")}
                options={rules.timings.map((t) => ({ value: t, label: TIMING_LABELS[t] }))}
              />
            </div>
            {e.timing === "time" ? (
              <TimeField id={`${prefix}-time`} label="Time" time={e.time} nextDay={e.next_day} eventDate={props.eventDate}
                onTime={(t) => onChange({ time: t })} onNextDay={(n) => onChange({ next_day: n })} error={errorFor("time")} />
            ) : null}
            {e.timing === "cue" ? text(`${prefix}-cue`, "Moment", e.cue, (v) => onChange({ cue: v }), errorFor("cue"), { hint: 'For example "After dessert" or "Right after the first dance".', wide: true }) : null}
            {rules.duration ? (
              <FieldBox id={`${prefix}-duration`} label="About how long, in minutes (optional)" error={errorFor("duration")}>
                <Input id={`${prefix}-duration`} inputMode="numeric" autoComplete="off" className="w-36" value={e.duration} onChange={(ev) => onChange({ duration: ev.target.value })} />
              </FieldBox>
            ) : null}
            {editor === "dedications" ? text(`${prefix}-message`, "Announcement message (optional)", e.message, (v) => onChange({ message: v }), errorFor("message"), { rows: 2 }) : null}
            {rules.song ? (
              <OptionalSong prefix={prefix} entry={e} needed={rules.requiresSong} name={String(e[nameField]).trim()} errorFor={errorFor} onChange={onChange} />
            ) : null}
            {text(`${prefix}-notes`, "Instructions (optional)", e.notes, (v) => onChange({ notes: v }), errorFor("notes"), { rows: 2 })}
          </>
        )}
        newEntry={(id) => emptyTimedEntry(id, editor)}
        check={(e) => timedEntryProblem(editor, e)}
        fieldError={props.fieldError}
      />
    </>
  );
}

const SONG_KEYS = { title: "song_title", artist: "song_artist", version: "song_version", link: "song_link" } as const;
const songOf = (e: TimedEntryForm) => ({ title: e.song_title, artist: e.song_artist, version: e.song_version, link: e.song_link });

/**
 * An activity's or dedication's song, out of the way until asked for: "Add a
 * song" opens the same fields as the songs lists (title, artist, version,
 * link). An entry that has a song shows it, and "Remove song" clears only the
 * song, never the entry. A dedication still needs one to be complete.
 */
function OptionalSong({ prefix, entry, needed, name, errorFor, onChange }: {
  prefix: string;
  entry: TimedEntryForm;
  needed: boolean;
  name: string;
  errorFor: (field: string) => string | null;
  onChange: (changes: Partial<TimedEntryForm>) => void;
}) {
  const hasSong = Object.values(songOf(entry)).some((v) => v.trim() !== "");
  const songError = Object.values(SONG_KEYS).some((k) => errorFor(k));
  const [adding, setAdding] = useState(false);
  const open = adding || hasSong || songError;
  const panel = `${prefix}-song`;
  const legend = needed ? "Music (needed to complete)" : "Music (optional)";
  return (
    <fieldset className="col-span-full grid gap-3 border-t border-plan-hairline pt-4">
      <legend className="mb-1 flex items-baseline gap-2 text-sm font-medium"><LabelText text={legend} /></legend>
      {open ? (
        <div id={panel} className="grid gap-3">
          <SongFields
            idPrefix={panel}
            song={songOf(entry)}
            inline
            errorFor={(f) => (f in SONG_KEYS ? errorFor(SONG_KEYS[f as keyof typeof SONG_KEYS]) : null)}
            onChange={(changes) => onChange(Object.fromEntries(Object.entries(changes).map(([k, v]) => [SONG_KEYS[k as keyof typeof SONG_KEYS], v])) as Partial<TimedEntryForm>)}
          />
          <Button type="button" size="sm" variant="ghost" className="w-fit text-destructive hover:bg-destructive/10 hover:text-destructive max-sm:min-h-11"
            aria-label={`Remove the song${name ? ` from "${name}"` : ""}`}
            onClick={() => {
              onChange({ song_title: "", song_artist: "", song_version: "", song_link: "" });
              setAdding(false);
            }}>
            Remove song
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="w-fit text-brand-ink hover:bg-brand-tint hover:text-brand-ink max-sm:min-h-11" aria-expanded={false} aria-controls={panel}
          onClick={() => {
            setAdding(true);
            requestAnimationFrame(() => document.getElementById(`${panel}-title`)?.focus());
          }}>
          <Plus aria-hidden className="size-4" />
          Add a song
        </Button>
      )}
    </fieldset>
  );
}

export function TimedEditorCard(props: Common<TimedAnswers> & { editor: "activities" | "dedications"; event: EventInfo }) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<TimedForm, TimedAnswers>({
    initialForm: timedForm(props.editor, props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: (f) => timedAnswersFromForm(props.editor, f),
    save: props.save,
    readOnly,
  });
  return (
    <Frame props={props as Common<unknown>} hint={WORDING[props.editor].hint} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      <TimedList editor={props.editor} base={props.momentKey} form={form} update={update} fieldError={fieldError} readOnly={readOnly} eventDate={props.event.date} audience={props.audience} />
    </Frame>
  );
}

export function ProgramEditor(props: Common<TimedAnswers> & { event: EventInfo }) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<ProgramForm, TimedAnswers>({
    initialForm: programForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: programAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const id = (f: string) => `${props.momentKey}-${f}`;
  const head: ReactNode = (
    <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium">The program overall (optional)</legend>
      <TimeField id={id("start_time")} label="Program starts (optional)" time={form.start_time} nextDay={form.start_next_day} eventDate={props.event.date}
        onTime={(t) => update({ start_time: t }, ["start_time", "end_time"])} onNextDay={(n) => update({ start_next_day: n }, ["start_time", "end_time"])}
        error={errorFor("start_time")} />
      <TimeField id={id("end_time")} label="Program ends (optional)" time={form.end_time} nextDay={form.end_next_day} eventDate={props.event.date}
        onTime={(t) => update({ end_time: t }, ["end_time"])} onNextDay={(n) => update({ end_next_day: n }, ["end_time"])}
        error={errorFor("end_time")} suggestNextDay={endNotAfterStart(form)} hint={endNotAfterStart(form) ? 'Ends after midnight? Check "Next day".' : undefined} />
      {text(id("host"), "Host (optional)", form.host, (v) => update({ host: v }, ["host"]), errorFor("host"))}
      {text(id("host_pronunciation"), "Host pronunciation guide (optional)", form.host_pronunciation, (v) => update({ host_pronunciation: v }, ["host_pronunciation"]), errorFor("host_pronunciation"), { hint: PRONUNCIATION_HINT })}
      {text(id("notes"), "Instructions (optional)", form.notes, (v) => update({ notes: v }, ["notes"]), errorFor("notes"), { rows: 2 })}
    </fieldset>
  );
  return (
    <Frame props={props as Common<unknown>} hint={WORDING.program.hint} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      {head}
      <div className="grid gap-2 border-t pt-3">
        <TimedList editor="program" base={props.momentKey} form={form} update={(c, clears) => update(c, clears)} fieldError={fieldError} readOnly={readOnly} eventDate={props.event.date} audience={props.audience} />
      </div>
    </Frame>
  );
}
