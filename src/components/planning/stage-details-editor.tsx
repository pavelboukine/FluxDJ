"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { endsAfterMidnight } from "@/lib/planning/basics";
import {
  STAGE_LAYOUT,
  nextDayLabel,
  stageAnswersFromForm,
  stageFormFromAnswers,
  type Block,
  type StageAnswers,
  type StageEditor,
  type StageForm,
} from "@/lib/planning/stages";
import type { SaveItemResult } from "@/lib/planning/view";
import { FieldBox } from "./basics-editor";
import { ItemChecklist, ItemWarnings, usePlanProgress } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

type Props = {
  itemId: string;
  stageKey: string;
  stageLabel: string;
  editor: StageEditor;
  initialAnswers: StageAnswers;
  initialRevision: number;
  event: { date: string; timezone: string; venueName: string | null; venueAddress: string | null };
  djName: string;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: StageAnswers) => Promise<SaveItemResult>;
  disabledReason?: string;
};

/**
 * Details of one stage, with autosave. Times are local to the event's time
 * zone and each carries an explicit "Next day" mark. Reuse choices (event
 * venue, Event basics' guest count and end time) store the choice, never a
 * copy, and show what they currently resolve to.
 */
export function StageDetailsEditor(props: Props) {
  const plan = usePlanProgress();
  const basics = plan?.basics ?? {};
  const readOnly = Boolean(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<StageForm, StageAnswers>({
    initialForm: stageFormFromAnswers(props.editor, props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: (f) => stageAnswersFromForm(props.editor, f),
    save: props.save,
    readOnly,
  });
  const id = (field: string) => `${props.stageKey}-${field}`;
  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);
  const str = (field: string) => (typeof form[field] === "string" ? (form[field] as string) : "");
  const nextDay = nextDayLabel(props.event.date);
  const eventVenue = props.event.venueName
    ? `${props.event.venueName}${props.event.venueAddress ? `, ${props.event.venueAddress}` : ""}`
    : basics.venue_details ?? null;

  const radio = (field: string, value: string, label: string) => (
    <label key={value} className="flex min-h-9 items-start gap-2 text-sm">
      <input
        type="radio"
        name={id(field)}
        className="mt-0.5 size-4 accent-primary"
        checked={form[field] === value}
        onChange={() => update({ [field]: value } as Partial<StageForm>)}
      />
      <span>{label}</span>
    </label>
  );
  const fieldError_ = (field: string) =>
    errorFor(field) ? <p id={`${id(field)}-error`} className="text-xs text-destructive">{errorFor(field)}</p> : null;

  const timeField = (prefix: string, label: string, hint?: string) => {
    const field = `${prefix}_time`;
    return (
      <FieldBox key={prefix} id={id(field)} label={label} error={errorFor(field)} hint={hint}>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id={id(field)}
            type="time"
            className="w-36"
            value={str(field)}
            onChange={(e) => update({ [field]: e.target.value } as Partial<StageForm>)}
            aria-invalid={Boolean(errorFor(field))}
            aria-describedby={errorFor(field) ? `${id(field)}-error` : undefined}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={form[`${prefix}_next_day`] === true}
              disabled={str(field) === ""}
              onChange={(e) => update({ [`${prefix}_next_day`]: e.target.checked } as Partial<StageForm>, ["end_time"])}
              aria-label={`${label.replace(/ \((needed|optional)\)$/, "")}: next day (${nextDay})`}
            />
            Next day ({nextDay})
          </label>
        </div>
      </FieldBox>
    );
  };

  const block = (b: Block, index: number) => {
    switch (b.type) {
      case "location":
        return (
          <fieldset key="location" className="grid gap-1.5 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">{b.label} (needed)</legend>
            {radio("location_source", "event_venue", `Same as the event venue${eventVenue ? ` (${eventVenue})` : " (not entered yet)"}`)}
            {radio("location_source", "other", "Somewhere else")}
            {form.location_source === "other" ? (
              <FieldBox id={id("location_other")} label="Place and address" error={errorFor("location_other")}>
                <Textarea id={id("location_other")} rows={2} value={str("location_other")} onChange={(e) => update({ location_other: e.target.value })} />
              </FieldBox>
            ) : null}
            <FieldBox id={id("location_area")} label="Room or outdoor area (optional)" error={errorFor("location_area")}>
              <Input id={id("location_area")} value={str("location_area")} onChange={(e) => update({ location_area: e.target.value })} />
            </FieldBox>
            {fieldError_("location_source")}
          </fieldset>
        );
      case "time":
        return timeField(b.prefix, b.label, b.hint);
      case "text":
        return (
          <FieldBox key={b.field} id={id(b.field)} className="sm:col-span-2" label={b.label} error={errorFor(b.field)} hint={b.hint}>
            {b.rows ? (
              <Textarea id={id(b.field)} rows={b.rows} value={str(b.field)} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)} />
            ) : (
              <Input id={id(b.field)} value={str(b.field)} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)} />
            )}
          </FieldBox>
        );
      case "choice":
        return (
          <fieldset key={b.field} className="grid gap-1 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">{b.label}</legend>
            {b.options.map(([value, label]) => radio(b.field, value, label))}
            {b.hint ? <p className="text-xs text-muted-foreground">{b.hint}</p> : null}
            {fieldError_(b.field)}
          </fieldset>
        );
      case "int":
        return (
          <FieldBox key={b.field} id={id(b.field)} label={b.label} error={errorFor(b.field)} hint={b.hint}>
            <Input id={id(b.field)} inputMode="numeric" autoComplete="off" className="w-36" value={str(b.field)} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)} />
          </FieldBox>
        );
      case "flag":
        return (
          <label key={b.field} className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="size-4 accent-primary" checked={form[b.field] === true} onChange={(e) => update({ [b.field]: e.target.checked } as Partial<StageForm>, ["entrance_time"])} />
            {b.label}
          </label>
        );
      case "guest_count":
        return (
          <fieldset key="guest_count" className="grid gap-1.5 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Guests at dinner (needed)</legend>
            {radio("guest_count_source", "basics", `Same as the guest count in Event basics${basics.guest_count ? ` (${basics.guest_count})` : " (not entered yet)"}`)}
            {radio("guest_count_source", "number", "A different number")}
            {form.guest_count_source === "number" ? (
              <FieldBox id={id("guest_count")} label="Guests at dinner" error={errorFor("guest_count")}>
                <Input id={id("guest_count")} inputMode="numeric" autoComplete="off" className="w-36" value={str("guest_count")} onChange={(e) => update({ guest_count: e.target.value })} />
              </FieldBox>
            ) : null}
          </fieldset>
        );
      case "finish": {
        const basicsEnd = basics.end_time
          ? `${basics.end_time}${endsAfterMidnight(basics.start_time, basics.end_time) ? ", next day" : ""}`
          : null;
        return (
          <fieldset key="finish" className="grid gap-1.5 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Planned finish (needed)</legend>
            {radio("finish_source", "time", "At a specific time")}
            {form.finish_source === "time" ? timeField("finish", "Finish time") : null}
            {radio("finish_source", "basics_end", `Same as the event end time in Event basics${basicsEnd ? ` (${basicsEnd})` : " (not entered yet)"}`)}
            {radio("finish_source", "discuss", `Not sure yet, discuss with ${props.audience === "client" ? props.djName : "the DJ"}`)}
          </fieldset>
        );
      }
      case "note":
        return <p key={`note-${index}`} className="text-xs text-muted-foreground sm:col-span-2">{b.text}</p>;
    }
  };

  return (
    <div className="grid gap-4" data-testid={`details-${props.stageKey}`}>
      <ItemChecklist itemId={props.itemId} title={`${props.stageLabel} details`} djName={props.djName} audience={props.audience} />
      <ItemWarnings itemId={props.itemId} />
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">{props.stageLabel} details</legend>
        {STAGE_LAYOUT[props.editor].map(block)}
      </fieldset>
      <p className="text-xs text-muted-foreground">Times are local to the event ({props.event.timezone}). Entering times never reorders the stages.</p>
      {!readOnly ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
    </div>
  );
}
