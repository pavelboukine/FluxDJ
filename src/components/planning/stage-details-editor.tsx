"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { endsAfterMidnight } from "@/lib/planning/basics";
import { zoneName } from "@/lib/planning/cutoff";
import { discussLabel, withDj } from "@/lib/planning/dj";
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
import { ChoiceFieldset, ChoiceOption, ChoiceSingle, SECONDARY_CHOICES } from "./choice-list";

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
  /** The heading the details sit under (the plan's own label for them), so the checklist names the same thing. */
  title?: string;
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
  const title = props.title ?? `${props.stageLabel} details`;
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

  const radio = (field: string, value: string, label: string, secondary = false) => (
    <ChoiceOption key={value} name={id(field)} checked={form[field] === value} secondary={secondary}
      onChange={() => update({ [field]: value } as Partial<StageForm>)} label={label} />
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
          <ChoiceFieldset
            key="location"
            legend={`${b.label} (needed)`}
            className="col-span-full"
            after={
              <>
                {fieldError_("location_source")}
                {form.location_source === "other" ? (
                  <FieldBox id={id("location_other")} label="Place and address" error={errorFor("location_other")}>
                    <Textarea id={id("location_other")} rows={2} value={str("location_other")} onChange={(e) => update({ location_other: e.target.value })} />
                  </FieldBox>
                ) : null}
                <FieldBox id={id("location_area")} label="Room or outdoor area (optional)" error={errorFor("location_area")}>
                  <Input id={id("location_area")} value={str("location_area")} onChange={(e) => update({ location_area: e.target.value })} />
                </FieldBox>
              </>
            }
          >
            {radio("location_source", "event_venue", `Same as the event venue${eventVenue ? ` (${eventVenue})` : " (not entered yet)"}`)}
            {radio("location_source", "other", "Somewhere else")}
          </ChoiceFieldset>
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
          <ChoiceFieldset
            key={b.field}
            legend={b.label}
            className="col-span-full"
            secondary={withDj(b.options, props.audience).some(({ value }) => SECONDARY_CHOICES.includes(value))
              ? withDj(b.options, props.audience).filter(({ value }) => SECONDARY_CHOICES.includes(value)).map(({ value, label }) => radio(b.field, value, label, true))
              : undefined}
            after={
              <>
                {b.hint ? <p className="text-xs text-plan-ink-2">{b.hint}</p> : null}
                {fieldError_(b.field)}
              </>
            }
          >
            {withDj(b.options, props.audience).filter(({ value }) => !SECONDARY_CHOICES.includes(value)).map(({ value, label }) => radio(b.field, value, label))}
          </ChoiceFieldset>
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
          <ChoiceSingle key={b.field} checked={form[b.field] === true} onChange={(checked) => update({ [b.field]: checked } as Partial<StageForm>, ["entrance_time"])} label={b.label} />
        );
      case "guest_count":
        return (
          <ChoiceFieldset
            key="guest_count"
            legend="Guests at dinner (needed)"
            className="col-span-full"
            after={form.guest_count_source === "number" ? (
              <FieldBox id={id("guest_count")} label="Guests at dinner" error={errorFor("guest_count")}>
                <Input id={id("guest_count")} inputMode="numeric" autoComplete="off" className="w-36" value={str("guest_count")} onChange={(e) => update({ guest_count: e.target.value })} />
              </FieldBox>
            ) : null}
          >
            {radio("guest_count_source", "basics", `Same as the guest count in Event basics${basics.guest_count ? ` (${basics.guest_count})` : " (not entered yet)"}`)}
            {radio("guest_count_source", "number", "A different number")}
          </ChoiceFieldset>
        );
      case "finish": {
        const basicsEnd = basics.end_time
          ? `${basics.end_time}${endsAfterMidnight(basics.start_time, basics.end_time) ? ", next day" : ""}`
          : null;
        return (
          <ChoiceFieldset
            key="finish"
            legend="Planned finish (needed)"
            className="col-span-full"
            secondary={radio("finish_source", "discuss", discussLabel(props.audience), true)}
            after={form.finish_source === "time" ? timeField("finish", "Finish time") : null}
          >
            {radio("finish_source", "time", "At a specific time")}
            {radio("finish_source", "basics_end", `Same as the event end time in Event basics${basicsEnd ? ` (${basicsEnd})` : " (not entered yet)"}`)}
          </ChoiceFieldset>
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
          <ChoiceFieldset
            key="grand_entrance"
            legend="Are you planning a formal grand entrance? (needed)"
            className="col-span-full"
            testId="grand-entrance"
            secondary={<ChoiceOption name={id("grand_entrance")} checked={decision === "undecided"} onChange={() => choose("undecided")} label="We're not sure yet" secondary />}
            after={<>
            {fieldError_("grand_entrance")}
            {decision === "planned" ? (
              <div className="grid gap-2">
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
            </>}
          >
            {([["planned", "Yes, we're planning a grand entrance"], ["none", "No, we'll skip the formal entrance"]] as [GrandEntrance, string][]).map(([value, label]) => (
              <ChoiceOption key={value} name={id("grand_entrance")} checked={decision === value} onChange={() => choose(value)} label={label} />
            ))}
          </ChoiceFieldset>
        );
      }
      case "note":
        return <p key={`note-${index}`} className="text-xs text-muted-foreground col-span-full">{b.text}</p>;
    }
  };

  return (
    <div className="grid gap-4" data-testid={`details-${props.stageKey}`}>
      <ItemChecklist itemId={props.itemId} title={title} djName={props.djName} audience={props.audience} />
      <ItemWarnings itemId={props.itemId} />
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">{title}</legend>
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
      <p data-plan-help className="text-xs text-muted-foreground">
        Times are local to the event ({zoneName(props.event.timezone)}). A time after midnight can be marked as the next day. Entering times never reorders the stages.
      </p>
      {!readOnly || saveState === "locked" ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
    </div>
  );
}
