"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { endsAfterMidnight } from "@/lib/planning/basics";
import {
  STAGE_LAYOUT,
  minutesOf,
  stageAnswersFromForm,
  stageFormFromAnswers,
  type Block,
  type GrandEntrance,
  type StageAnswers,
  type StageEditor,
  type StageForm,
} from "@/lib/planning/stages";
import type { SaveItemResult } from "@/lib/planning/view";
import { FieldBox, describedBy } from "./basics-editor";
import { useGrandEntrance } from "./grand-entrance";
import { ItemChecklist, ItemWarnings, useEditingClosed, usePlanProgress } from "./progress";
import { TimeField } from "./time-field";
import { SaveStatus, useAutosave } from "./use-autosave";

type TimeBlock = Extract<Block, { type: "time" }>;

/** The layout with each run of consecutive time questions grouped. */
function timeRuns(blocks: Block[]): (Block | TimeBlock[])[] {
  const out: (Block | TimeBlock[])[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === "time" && Array.isArray(last)) last.push(b);
    else out.push(b.type === "time" ? [b] : b);
  }
  return out;
}

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
 * zone and each carries an explicit "Next day" mark, offered only where it
 * can matter (see TimeField). Reuse choices (event
 * venue, Event basics' guest count and end time) store the choice, never a
 * copy, and show what they currently resolve to.
 */
export function StageDetailsEditor(props: Props) {
  const plan = usePlanProgress();
  const basics = plan?.basics ?? {};
  const readOnly = useEditingClosed(props.disabledReason);
  const entrance = useGrandEntrance();
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

  // An end at or before its start is offered "Next day" (never assumed).
  const start = minutesOf(form, "start");
  const timeField = (prefix: string, label: string, hint?: string) => {
    const field = `${prefix}_time`;
    const at = minutesOf(form, prefix);
    return (
      <TimeField
        key={prefix}
        id={id(field)}
        label={label}
        time={str(field)}
        nextDay={form[`${prefix}_next_day`] === true}
        onTime={(time) => update({ [field]: time } as Partial<StageForm>)}
        onNextDay={(checked) => update({ [`${prefix}_next_day`]: checked } as Partial<StageForm>, ["end_time"])}
        eventDate={props.event.date}
        error={errorFor(field)}
        hint={hint}
        suggestNextDay={prefix === "end" && start !== null && at !== null && at <= start}
      />
    );
  };

  const block = (b: Block, index: number) => {
    switch (b.type) {
      case "location":
        return (
          <fieldset key="location" className="grid gap-1.5 col-span-full">
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
          <FieldBox key={b.field} id={id(b.field)} className="col-span-full" label={b.label} error={errorFor(b.field)} hint={b.hint}>
            {b.rows ? (
              <Textarea id={id(b.field)} rows={b.rows} value={str(b.field)} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)}
                aria-invalid={Boolean(errorFor(b.field))} aria-describedby={describedBy(id(b.field), errorFor(b.field), b.hint)} />
            ) : (
              <Input id={id(b.field)} value={str(b.field)} placeholder={b.placeholder} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)}
                aria-invalid={Boolean(errorFor(b.field))} aria-describedby={describedBy(id(b.field), errorFor(b.field), b.hint)} />
            )}
          </FieldBox>
        );
      case "choice":
        return (
          <fieldset key={b.field} className="grid gap-1 col-span-full">
            <legend className="mb-1 text-sm font-medium">{b.label}</legend>
            {b.options.map(([value, label]) => radio(b.field, value, label))}
            {b.hint ? <p className="text-xs text-muted-foreground">{b.hint}</p> : null}
            {fieldError_(b.field)}
          </fieldset>
        );
      case "int":
        return (
          <FieldBox key={b.field} id={id(b.field)} label={b.label} error={errorFor(b.field)} hint={b.hint}>
            <Input id={id(b.field)} inputMode="numeric" autoComplete="off" className="w-36" value={str(b.field)} onChange={(e) => update({ [b.field]: e.target.value } as Partial<StageForm>)}
              aria-invalid={Boolean(errorFor(b.field))} aria-describedby={describedBy(id(b.field), errorFor(b.field), b.hint)} />
          </FieldBox>
        );
      case "flag":
        return (
          <label key={b.field} className="flex items-center gap-2 text-sm col-span-full">
            <input type="checkbox" className="size-4 accent-primary" checked={form[b.field] === true} onChange={(e) => update({ [b.field]: e.target.checked } as Partial<StageForm>, ["entrance_time"])} />
            {b.label}
          </label>
        );
      case "guest_count":
        return (
          <fieldset key="guest_count" className="grid gap-1.5 col-span-full">
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
          <fieldset key="finish" className="grid gap-1.5 col-span-full">
            <legend className="mb-1 text-sm font-medium">Planned finish (needed)</legend>
            {radio("finish_source", "time", "At a specific time")}
            {form.finish_source === "time" ? timeField("finish", "Finish time") : null}
            {radio("finish_source", "basics_end", `Same as the event end time in Event basics${basicsEnd ? ` (${basicsEnd})` : " (not entered yet)"}`)}
            {radio("finish_source", "discuss", `Not sure yet, discuss with ${props.audience === "client" ? props.djName : "the DJ"}`)}
          </fieldset>
        );
      }
      case "grand_entrance": {
        const decision = str("grand_entrance") as GrandEntrance | "";
        const choose = (value: GrandEntrance) => {
          update({ grand_entrance: value }, ["entrance_time"]);
          entrance?.set(value);
        };
        // Answers kept while the entrance is skipped or undecided (never cleared).
        const kept = (decision === "none" || decision === "undecided") && (str("entrance_time") !== "" || Boolean(entrance?.saved));
        return (
          <fieldset key="grand_entrance" className="grid gap-1.5 col-span-full" data-testid="grand-entrance">
            <legend className="mb-1 text-sm font-medium">Are you planning a formal grand entrance? (needed)</legend>
            {([["planned", "Yes, we're planning a grand entrance"], ["none", "No, we'll skip the formal entrance"], ["undecided", "We're not sure yet"]] as [GrandEntrance, string][]).map(([value, label]) => (
              <label key={value} className="flex min-h-9 items-start gap-2 text-sm">
                <input type="radio" name={id("grand_entrance")} className="mt-0.5 size-4 accent-primary" checked={decision === value} onChange={() => choose(value)} />
                <span>{label}</span>
              </label>
            ))}
            {fieldError_("grand_entrance")}
            {decision === "planned" ? (
              <div className="mt-2 grid gap-2 border-l-2 pl-4">
                {timeField("entrance", "Planned grand entrance time (needed)", "When should the DJ or MC begin introducing the wedding party and/or couple?")}
                <p className="text-xs text-muted-foreground">Who is introduced, how to announce them and the song for each go in the grand entrance order below.</p>
              </div>
            ) : decision === "none" ? (
              <p className="text-xs text-muted-foreground">Nothing else is needed for an entrance. The guest entry time above still helps the DJ plan.</p>
            ) : decision === "undecided" ? (
              <p className="text-xs text-muted-foreground">That&apos;s fine: keep planning the other sections and come back to this when you know.</p>
            ) : null}
            {kept ? (
              <p className="text-xs text-muted-foreground" data-testid="grand-entrance-kept">
                What you already entered for the grand entrance is kept, and comes back if you choose &ldquo;Yes&rdquo;.
              </p>
            ) : null}
          </fieldset>
        );
      }
      case "note":
        return <p key={`note-${index}`} className="text-xs text-muted-foreground col-span-full">{b.text}</p>;
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
        {timeRuns(STAGE_LAYOUT[props.editor]).map((run, index) =>
          Array.isArray(run) ? (
            // A stage's times (arrival, start, end) side by side, wrapping on narrow screens.
            <div key={`times-${index}`} className="col-span-full flex flex-wrap items-start gap-x-8 gap-y-4">
              {run.map((b) => timeField(b.prefix, b.label, b.hint))}
            </div>
          ) : (
            block(run, index)
          ),
        )}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Times are local to the event ({props.event.timezone}). A time after midnight can be marked as the next day. Entering times never reorders the stages.
      </p>
      {!readOnly || saveState === "locked" ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
    </div>
  );
}
