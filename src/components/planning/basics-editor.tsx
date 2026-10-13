"use client";

import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { selectClass } from "@/components/app/fields";
import {
  ANNOUNCEMENT_LANGUAGES,
  answersFromForm,
  endsAfterMidnight,
  formFromAnswers,
  type BasicsAnswers,
  type BasicsField,
} from "@/lib/planning/basics";
import type { SaveItemResult } from "@/lib/planning/view";
import { cn } from "@/lib/utils";
import { ItemChecklist, useEditingClosed, usePlanProgress, usePublishLanguage } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

type Props = {
  itemId: string;
  initialAnswers: BasicsAnswers;
  initialRevision: number;
  /** The venue staff entered on the event, shown instead of asking for it. */
  eventVenue: { name: string | null; address: string | null };
  djName: string;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: BasicsAnswers) => Promise<SaveItemResult>;
  disabledReason?: string;
  /**
   * DJ expectations is part of the plan, so the announcement language is asked
   * there (see languageAskedInPreferences). It's still this item's answer,
   * saved by this editor.
   */
  languageInPreferences?: boolean;
};

/**
 * Event basics with autosave (see useAutosave). Saved answers are shared
 * with the stage editors, which can reuse the venue, guest count and end time.
 */
export function BasicsEditor(props: Props) {
  const plan = usePlanProgress();
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave({
    initialForm: formFromAnswers(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: answersFromForm,
    save: props.save,
    readOnly,
    onSaved: (answers) => plan?.setBasics(answers as BasicsAnswers),
  });

  const errorFor = (field: BasicsField) => (fieldError?.field === field ? fieldError.message : null);
  // Every field here but the room has a hint.
  const description = (field: BasicsField) => describedBy(field, errorFor(field), field === "venue_room" ? undefined : "hint");

  // When DJ expectations asks the language, it edits it through this editor's form and autosave.
  const publishLanguage = usePublishLanguage();
  const languageError = errorFor("announcement_language");
  const latest = useRef({ update, retry });
  useEffect(() => {
    latest.current = { update, retry };
  });
  useEffect(() => {
    if (!publishLanguage || !props.languageInPreferences) return;
    publishLanguage({
      value: form.announcement_language,
      set: (value) => latest.current.update({ announcement_language: value }),
      error: languageError,
      saveState,
      message,
      retry: () => latest.current.retry(),
    });
  }, [publishLanguage, props.languageInPreferences, form.announcement_language, languageError, saveState, message]);
  useEffect(() => {
    if (!publishLanguage || !props.languageInPreferences) return;
    return () => publishLanguage(null);
  }, [publishLanguage, props.languageInPreferences]);
  const parsedTimes = answersFromForm(form);
  const overnight = parsedTimes.ok && endsAfterMidnight(parsedTimes.answers.start_time, parsedTimes.answers.end_time);
  const you = props.audience === "client" ? "you" : "the client";

  return (
    <div className="grid gap-4">
      <ItemChecklist itemId={props.itemId} title="Event basics" djName={props.djName} audience={props.audience} />
      {props.disabledReason ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{props.disabledReason}</p>
      ) : null}
      <fieldset disabled={readOnly} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Event basics</legend>
        <FieldBox id="guest_count" label="Guest count (needed)" error={errorFor("guest_count")} hint="An estimate is fine.">
          <Input
            id="guest_count"
            inputMode="numeric"
            autoComplete="off"
            value={form.guest_count}
            onChange={(e) => update({ guest_count: e.target.value })}
            aria-invalid={Boolean(errorFor("guest_count"))}
            aria-describedby={description("guest_count")}
          />
        </FieldBox>
        {props.languageInPreferences ? null : (
          <FieldBox id="announcement_language" label="Language for announcements (optional)" error={errorFor("announcement_language")}>
            <LanguageSelect id="announcement_language" value={form.announcement_language} onChange={(v) => update({ announcement_language: v })} error={errorFor("announcement_language")} />
          </FieldBox>
        )}
        {/* Start and end share a row, after the guest count (and the language, when asked here). */}
        <FieldBox id="start_time" className="sm:col-start-1" label="Start time (needed)" error={errorFor("start_time")} hint="When the DJ's part of the event begins, local time.">
          <Input
            id="start_time"
            type="time"
            value={form.start_time}
            onChange={(e) => update({ start_time: e.target.value })}
            aria-invalid={Boolean(errorFor("start_time"))}
            aria-describedby={description("start_time")}
          />
        </FieldBox>
        <FieldBox
          id="end_time"
          label="End time (needed)"
          error={errorFor("end_time")}
          hint={overnight ? "Ends after midnight, the next day." : "When the music stops. A time earlier than the start means after midnight."}
        >
          <Input
            id="end_time"
            type="time"
            value={form.end_time}
            onChange={(e) => update({ end_time: e.target.value })}
            aria-invalid={Boolean(errorFor("end_time"))}
            aria-describedby={description("end_time")}
          />
        </FieldBox>
        {props.eventVenue.name ? (
          <div className="grid gap-1 text-sm col-span-full">
            <span className="font-medium">Venue</span>
            <span>{props.eventVenue.name}{props.eventVenue.address ? `, ${props.eventVenue.address}` : ""}</span>
            <span className="text-xs text-muted-foreground">
              {props.audience === "client"
                ? `Provided by ${props.djName}. Contact them if it changes.`
                : "From the event details. Edit it on the event page."}
            </span>
          </div>
        ) : (
          <FieldBox
            id="venue_details"
            className="col-span-full"
            label="Where is the event? (needed)"
            error={errorFor("venue_details")}
            hint={props.audience === "client" ? `Venue name and address, if ${props.djName} doesn't have it yet.` : "Shown because the event has no venue yet. Adding one on the event page also satisfies this."}
          >
            <Textarea
              id="venue_details"
              rows={2}
              value={form.venue_details}
              onChange={(e) => update({ venue_details: e.target.value })}
              aria-invalid={Boolean(errorFor("venue_details"))}
              aria-describedby={description("venue_details")}
            />
          </FieldBox>
        )}
        <FieldBox id="venue_room" className="col-span-full" label="Room or space within the venue (optional)" error={errorFor("venue_room")}>
          <Input id="venue_room" value={form.venue_room} onChange={(e) => update({ venue_room: e.target.value })} aria-describedby={description("venue_room")} />
        </FieldBox>
        <FieldBox
          id="access_notes"
          className="col-span-full"
          label="Parking, loading and access for the DJ (needed)"
          error={errorFor("access_notes")}
          hint={`Stairs, elevators, loading doors, parking or set-up times. If there is nothing to know, check the box below.`}
        >
          <Textarea
            id="access_notes"
            rows={3}
            value={form.access_notes}
            onChange={(e) => update({ access_notes: e.target.value })}
            aria-invalid={Boolean(errorFor("access_notes"))}
            aria-describedby={description("access_notes")}
          />
        </FieldBox>
        <label className="flex items-center gap-2 text-sm col-span-full">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={form.access_notes_none}
            onChange={(e) => update({ access_notes_none: e.target.checked }, ["access_notes"])}
          />
          No special instructions
        </label>
      </fieldset>
      {!readOnly || saveState === "locked" ? <SaveStatus saveState={saveState} message={message} retry={retry} /> : null}
      <p className="text-xs text-muted-foreground">
        Answers save automatically. Saving these never changes the contract, its price or payments
        {props.audience === "client" ? "" : `, and ${you} sees the same answers`}.
      </p>
    </div>
  );
}

/**
 * One labelled field: label, control, then its error or hint (nothing when it
 * has neither). Its rows stay at the top (content-start): in a two-column
 * grid a shorter field would otherwise stretch to its neighbour's height and
 * spread its label, control and hint apart.
 */
export function FieldBox({ id, label, hint, error, className, children }: { id: string; label: string; hint?: string; error: string | null; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** The aria-describedby for a FieldBox's control: its error, else its hint. */
export function describedBy(id: string, error: string | null | undefined, hint?: string): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

/** The announcement language choices (stored as Event basics' answer, wherever it's asked). */
export function LanguageSelect({ id, value, onChange, error, hint, disabled }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <select id={id} className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      aria-invalid={Boolean(error)} aria-describedby={describedBy(id, error, hint)}>
      <option value="">— not chosen —</option>
      {ANNOUNCEMENT_LANGUAGES.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}
