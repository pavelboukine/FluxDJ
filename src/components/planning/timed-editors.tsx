"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { endsAfterMidnight } from "@/lib/planning/basics";
import type { ListChoice } from "@/lib/planning/participants";
import { nextDayLabel } from "@/lib/planning/stages";
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
import { Choices, EntryList, Frame, PRONUNCIATION_HINT, text, type Common } from "./participants-editor";
import { usePlanProgress } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

type EventInfo = { date: string; timezone: string; venueName: string | null; venueAddress: string | null };
const djText = (props: { audience: "client" | "staff"; djName: string }) => (props.audience === "client" ? props.djName : "the DJ");

/** A local time with its explicit "Next day" mark, as in stage details. */
function TimeField({ id, label, time, nextDay, onChange, error, eventDate, hint }: {
  id: string; label: string; time: string; nextDay: boolean; onChange: (c: { time?: string; nextDay?: boolean }) => void; error: string | null; eventDate: string; hint?: string;
}) {
  const next = nextDayLabel(eventDate);
  return (
    <FieldBox id={id} label={label} error={error} hint={hint} className="sm:col-span-2">
      <div className="flex flex-wrap items-center gap-3">
        <Input id={id} type="time" className="w-36" value={time} onChange={(e) => onChange({ time: e.target.value })} aria-invalid={Boolean(error)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={nextDay} disabled={time === ""} onChange={(e) => onChange({ nextDay: e.target.checked })}
            aria-label={`${label.replace(/ \((needed|optional)\)$/, "")}: next day (${next})`} />
          Next day ({next})
        </label>
      </div>
    </FieldBox>
  );
}

// ---------------------------------------------------------------------------
// Arrival details
// ---------------------------------------------------------------------------

export function ArrivalEditor(props: Common<ArrivalAnswers> & { event: EventInfo; ceremony: Record<string, unknown> | null }) {
  const readOnly = Boolean(props.disabledReason);
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
    <label key={value} className="flex min-h-9 items-start gap-2 text-sm">
      <input type="radio" name={id(field)} className="mt-0.5 size-4 accent-primary" checked={form[field] === value} disabled={none}
        onChange={() => update({ [field]: value } as Partial<ArrivalForm>, [field, "arrival_none"])} />
      <span>{label}</span>
    </label>
  );
  return (
    <Frame
      props={props as Common<unknown>}
      hint={`General guest arrival, before anything else. Ceremony guest arrival stays in the Ceremony details; reuse it here instead of typing it twice. Times are local to the event (${props.event.timezone}). Arrival music has its own card.`}
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Arrival details</legend>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="size-4 accent-primary" checked={none} onChange={(e) => update({ arrival_none: e.target.checked }, ["arrival_none"])} />
          No separate arrival arrangements
        </label>
        {errorFor("arrival_none") ? <p className="text-xs text-destructive sm:col-span-2">{errorFor("arrival_none")}</p> : null}
        <fieldset className="grid gap-1.5 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">Where do guests arrive? (needed)</legend>
          {radio("location_source", "event_venue", `Same as the event venue${venue ? ` (${venue})` : " (not entered yet)"}`)}
          {radio("location_source", "ceremony", `Same as the ceremony${ceremonyPlace ? ` (${ceremonyPlace})` : " (not in the Ceremony details yet)"}`)}
          {radio("location_source", "other", "Somewhere else")}
          {form.location_source === "other" ? text(id("location_other"), "Place and address", form.location_other, (v) => update({ location_other: v }, ["location_other"]), errorFor("location_other"), { rows: 2 }) : null}
          {text(id("location_area"), "Room or outdoor area (optional)", form.location_area, (v) => update({ location_area: v }, ["location_area"]), errorFor("location_area"))}
        </fieldset>
        <fieldset className="grid gap-1.5 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">When do guests arrive? (needed)</legend>
          {radio("time_source", "ceremony", `Same as the ceremony's guest arrival${ceremonyArrival ? ` (${ceremonyArrival})` : " (not in the Ceremony details yet)"}`)}
          {radio("time_source", "time", "At a specific time")}
          {form.time_source === "time" ? (
            <>
              <TimeField id={id("start_time")} label="Arrival starts (needed)" time={form.start_time} nextDay={form.start_next_day} eventDate={props.event.date}
                onChange={(ch) => update({ ...(ch.time !== undefined ? { start_time: ch.time } : {}), ...(ch.nextDay !== undefined ? { start_next_day: ch.nextDay } : {}) }, ["start_time", "end_time"])}
                error={errorFor("start_time")} />
              <TimeField id={id("end_time")} label="Arrival ends (optional)" time={form.end_time} nextDay={form.end_next_day} eventDate={props.event.date}
                onChange={(ch) => update({ ...(ch.time !== undefined ? { end_time: ch.time } : {}), ...(ch.nextDay !== undefined ? { end_next_day: ch.nextDay } : {}) }, ["end_time"])}
                error={errorFor("end_time")} />
            </>
          ) : null}
        </fieldset>
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
  dj: string;
}) {
  const { editor, form, update } = props;
  const rules = TIMED_RULES[editor];
  const w = WORDING[editor];
  const nameField = rules.name as keyof TimedEntryForm;
  const blocked = form.entries.length > 0 ? "Remove the entries to choose this." : null;
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
          { value: "discuss", label: `Not sure yet, discuss with ${props.dj}` },
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
              <p className="font-medium [overflow-wrap:anywhere]">
                {index + 1}. {String(e[nameField]).trim() || "Unnamed"}
                {e.pronunciation.trim() ? <span className="font-normal text-muted-foreground"> (say: {e.pronunciation.trim()})</span> : null}
              </p>
              {who ? <p className="text-xs [overflow-wrap:anywhere]">{who}</p> : null}
              <p className={when ? "text-xs" : "text-xs text-amber-700 dark:text-amber-400"}>
                {when ?? "Timing not decided yet"}{rules.duration && e.duration.trim() ? ` · about ${e.duration.trim()} min` : ""}
              </p>
              {rules.song ? (
                e.song_title.trim() ? (
                  <p className="text-xs [overflow-wrap:anywhere]">
                    Song: {e.song_title} by {e.song_artist}{e.song_version.trim() ? ` (${e.song_version.trim()})` : ""}
                    {e.song_link.trim() && isHttpsUrl(e.song_link.trim()) ? (
                      <> · <a className="underline" href={e.song_link.trim()} target="_blank" rel="noopener noreferrer nofollow">Open link ({linkHost(e.song_link.trim())})</a></>
                    ) : null}
                  </p>
                ) : songMissing ? <p className="text-xs text-amber-700 dark:text-amber-400">Song not chosen yet</p> : null
              ) : null}
              {e.message.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Message: {e.message}</p> : null}
              {e.notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Instructions: {e.notes}</p> : null}
            </>
          );
        }}
        fields={(e, onChange, errorFor, prefix) => (
          <>
            <FieldBox id={`${prefix}-${rules.name}`} label={w.name} error={errorFor(rules.name)} hint={w.nameHint} className="sm:col-span-2">
              <Input id={`${prefix}-${rules.name}`} list={editor === "activities" ? `${props.base}-suggestions` : undefined} value={String(e[nameField])}
                onChange={(ev) => onChange({ [rules.name]: ev.target.value } as Partial<TimedEntryForm>)} aria-invalid={Boolean(errorFor(rules.name))} />
            </FieldBox>
            {editor === "program" ? text(`${prefix}-presenter`, "Presenter (optional)", e.presenter, (v) => onChange({ presenter: v }), errorFor("presenter")) : null}
            {editor === "activities" ? text(`${prefix}-host`, "Host (optional)", e.host, (v) => onChange({ host: v }), errorFor("host")) : null}
            {editor === "activities" ? text(`${prefix}-participants`, "Participants (optional)", e.participants, (v) => onChange({ participants: v }), errorFor("participants")) : null}
            {editor === "dedications" ? text(`${prefix}-relationship`, "Relationship (optional)", e.relationship, (v) => onChange({ relationship: v }), errorFor("relationship")) : null}
            {text(`${prefix}-pronunciation`, "Pronunciation guide (optional)", e.pronunciation, (v) => onChange({ pronunciation: v }), errorFor("pronunciation"), { hint: PRONUNCIATION_HINT })}
            <fieldset className="grid gap-1 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">When (needed to complete)</legend>
              {rules.timings.map((t) => (
                <label key={t} className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="radio" name={`${prefix}-timing`} className="size-4 accent-primary" checked={e.timing === t} onChange={() => onChange({ timing: t })} />
                  {TIMING_LABELS[t]}
                </label>
              ))}
              {errorFor("timing") ? <p className="text-xs text-destructive">{errorFor("timing")}</p> : null}
            </fieldset>
            {e.timing === "time" ? (
              <TimeField id={`${prefix}-time`} label="Time" time={e.time} nextDay={e.next_day} eventDate={props.eventDate}
                onChange={(ch) => onChange({ ...(ch.time !== undefined ? { time: ch.time } : {}), ...(ch.nextDay !== undefined ? { next_day: ch.nextDay } : {}) })} error={errorFor("time")} />
            ) : null}
            {e.timing === "cue" ? text(`${prefix}-cue`, "Moment", e.cue, (v) => onChange({ cue: v }), errorFor("cue"), { hint: 'For example "After dessert" or "Right after the first dance".', wide: true }) : null}
            {rules.duration ? (
              <FieldBox id={`${prefix}-duration`} label="About how long, in minutes (optional)" error={errorFor("duration")}>
                <Input id={`${prefix}-duration`} inputMode="numeric" autoComplete="off" className="w-36" value={e.duration} onChange={(ev) => onChange({ duration: ev.target.value })} />
              </FieldBox>
            ) : null}
            {editor === "dedications" ? text(`${prefix}-message`, "Announcement message (optional)", e.message, (v) => onChange({ message: v }), errorFor("message"), { rows: 2 }) : null}
            {rules.song ? (
              <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">{rules.requiresSong ? "Song (needed to complete)" : "Song (optional)"}</legend>
                {text(`${prefix}-song_title`, "Song title", e.song_title, (v) => onChange({ song_title: v }), errorFor("song_title"))}
                {text(`${prefix}-song_artist`, "Song artist", e.song_artist, (v) => onChange({ song_artist: v }), errorFor("song_artist"))}
                {text(`${prefix}-song_version`, "Version (optional)", e.song_version, (v) => onChange({ song_version: v }), errorFor("song_version"))}
                {text(`${prefix}-song_link`, "Link (optional)", e.song_link, (v) => onChange({ song_link: v }), errorFor("song_link"), { hint: "An https:// link to help the DJ find it. It's never opened automatically." })}
              </fieldset>
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

export function TimedEditorCard(props: Common<TimedAnswers> & { editor: "activities" | "dedications"; event: EventInfo }) {
  const readOnly = Boolean(props.disabledReason);
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
      <TimedList editor={props.editor} base={props.momentKey} form={form} update={update} fieldError={fieldError} readOnly={readOnly} eventDate={props.event.date} dj={djText(props)} />
    </Frame>
  );
}

export function ProgramEditor(props: Common<TimedAnswers> & { event: EventInfo }) {
  const readOnly = Boolean(props.disabledReason);
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
  const overnight = form.start_time && form.end_time && !form.end_next_day && endsAfterMidnight(form.start_time, form.end_time);
  const head: ReactNode = (
    <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium">The program overall (optional)</legend>
      <TimeField id={id("start_time")} label="Program starts (optional)" time={form.start_time} nextDay={form.start_next_day} eventDate={props.event.date}
        onChange={(ch) => update({ ...(ch.time !== undefined ? { start_time: ch.time } : {}), ...(ch.nextDay !== undefined ? { start_next_day: ch.nextDay } : {}) }, ["start_time", "end_time"])}
        error={errorFor("start_time")} />
      <TimeField id={id("end_time")} label="Program ends (optional)" time={form.end_time} nextDay={form.end_next_day} eventDate={props.event.date}
        onChange={(ch) => update({ ...(ch.time !== undefined ? { end_time: ch.time } : {}), ...(ch.nextDay !== undefined ? { end_next_day: ch.nextDay } : {}) }, ["end_time"])}
        error={errorFor("end_time")} hint={overnight ? 'Ends after midnight? Check "Next day".' : undefined} />
      {text(id("host"), "Host (optional)", form.host, (v) => update({ host: v }, ["host"]), errorFor("host"))}
      {text(id("host_pronunciation"), "Host pronunciation guide (optional)", form.host_pronunciation, (v) => update({ host_pronunciation: v }, ["host_pronunciation"]), errorFor("host_pronunciation"), { hint: PRONUNCIATION_HINT })}
      {text(id("notes"), "Instructions (optional)", form.notes, (v) => update({ notes: v }, ["notes"]), errorFor("notes"), { rows: 2 })}
    </fieldset>
  );
  return (
    <Frame props={props as Common<unknown>} hint={WORDING.program.hint} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      {head}
      <div className="grid gap-2 border-t pt-3">
        <TimedList editor="program" base={props.momentKey} form={form} update={(c, clears) => update(c, clears)} fieldError={fieldError} readOnly={readOnly} eventDate={props.event.date} dj={djText(props)} />
      </div>
    </Frame>
  );
}
