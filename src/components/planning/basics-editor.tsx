"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { selectClass } from "@/components/app/fields";
import {
  ANNOUNCEMENT_LANGUAGES,
  answersFromForm,
  answersKey,
  endsAfterMidnight,
  formFromAnswers,
  type BasicsAnswers,
  type BasicsField,
  type BasicsForm,
} from "@/lib/planning/basics";
import type { SaveBasicsResult } from "@/lib/planning/view";
import { BasicsChecklist, usePlanProgress } from "./progress";

type SaveState = "saved" | "unsaved" | "saving" | "invalid" | "error" | "conflict" | "signed_out" | "unavailable";

type Props = {
  initialAnswers: BasicsAnswers;
  initialRevision: number;
  /** The venue staff entered on the event, shown instead of asking for it. */
  eventVenue: { name: string | null; address: string | null };
  djName: string;
  audience: "client" | "staff";
  save: (expectedRevision: number, answers: BasicsAnswers) => Promise<SaveBasicsResult>;
  disabledReason?: string;
};

const AUTOSAVE_DELAY_MS = 800;

/**
 * Event basics with autosave. The form lives in React state, so edits typed
 * while a save is in flight are kept; one save runs at a time, and if the
 * form changed meanwhile another follows. A stale revision (another tab or
 * window) is a conflict that never overwrites anything; failures keep every
 * input and offer Retry. Progress shown comes from the server's answer.
 */
export function BasicsEditor(props: Props) {
  const progress = usePlanProgress();
  const [form, setForm] = useState<BasicsForm>(() => formFromAnswers(props.initialAnswers));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const formRef = useRef(form);
  const revisionRef = useRef(props.initialRevision);
  const savedKey = useRef(answersKey(props.initialAnswers));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const stopped = useRef(false);
  const readOnly = Boolean(props.disabledReason);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) await inFlight.current;
    if (stopped.current) return;
    const parsed = answersFromForm(formRef.current);
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      setSaveState("invalid");
      return;
    }
    const key = answersKey(parsed.answers);
    if (key === savedKey.current) {
      setSaveState("saved");
      return;
    }
    const run = (async () => {
      setSaveState("saving");
      setMessage(null);
      try {
        const result = await props.save(revisionRef.current, parsed.answers);
        switch (result.status) {
          case "saved": {
            revisionRef.current = result.revision;
            savedKey.current = answersKey(result.answers);
            progress?.setProgress(result.progress);
            const now = answersFromForm(formRef.current);
            const newer = !now.ok || answersKey(now.answers) !== savedKey.current;
            setSaveState(newer ? "unsaved" : "saved");
            if (newer) timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
            break;
          }
          case "conflict":
            stopped.current = true;
            setSaveState("conflict");
            break;
          case "invalid":
            setFieldError(result.field ? { field: result.field, message: result.message } : null);
            setMessage(result.message);
            setSaveState("invalid");
            break;
          case "signed_out":
            setSaveState("signed_out");
            break;
          case "unavailable":
            stopped.current = true;
            setSaveState("unavailable");
            break;
          case "error":
            setMessage(result.message);
            setSaveState("error");
            break;
        }
      } catch {
        setMessage("Couldn't save. Check your connection and retry. Your answers are still here.");
        setSaveState("error");
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, [props, progress]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function update<K extends BasicsField>(field: K, value: BasicsForm[K]) {
    if (readOnly) return;
    const next = { ...formRef.current, [field]: value };
    formRef.current = next;
    setForm(next);
    if (fieldError && (fieldError.field === field || (field === "access_notes_none" && fieldError.field === "access_notes"))) setFieldError(null);
    // After a conflict or loss of access, typing stays on screen but is never sent.
    if (stopped.current) return;
    setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
  }

  function retry() {
    if (timer.current) clearTimeout(timer.current);
    void save();
  }

  const errorFor = (field: BasicsField) => (fieldError?.field === field ? fieldError.message : null);
  const describedBy = (field: BasicsField) => (errorFor(field) ? `${field}-error` : undefined);
  const parsedTimes = answersFromForm(form);
  const overnight = parsedTimes.ok && endsAfterMidnight(parsedTimes.answers.start_time, parsedTimes.answers.end_time);
  const you = props.audience === "client" ? "you" : "the client";

  const status: Record<SaveState, string> = {
    saved: "All changes saved",
    unsaved: "Unsaved changes",
    saving: "Saving…",
    invalid: "Fix the highlighted answer to save.",
    error: message ?? "Couldn't save your changes.",
    conflict: "These answers were changed in another tab or window. Reload to see the latest before continuing. Your typing here is not saved.",
    signed_out: "Your session has ended. Sign in again in a new tab, then retry. Your answers are still here.",
    unavailable: "Planning isn't available for this event any more. Your answers on this page were not saved.",
  };
  const alerting = saveState === "error" || saveState === "conflict" || saveState === "signed_out" || saveState === "unavailable" || saveState === "invalid";

  return (
    <div className="grid gap-4">
      <BasicsChecklist djName={props.djName} audience={props.audience} />
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
            onChange={(e) => update("guest_count", e.target.value)}
            aria-invalid={Boolean(errorFor("guest_count"))}
            aria-describedby={describedBy("guest_count")}
          />
        </FieldBox>
        <FieldBox id="announcement_language" label="Language for announcements (optional)" error={errorFor("announcement_language")}>
          <select
            id="announcement_language"
            className={selectClass}
            value={form.announcement_language}
            onChange={(e) => update("announcement_language", e.target.value)}
          >
            <option value="">— not chosen —</option>
            {ANNOUNCEMENT_LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </FieldBox>
        <FieldBox id="start_time" label="Start time (needed)" error={errorFor("start_time")} hint="When the DJ's part of the event begins, local time.">
          <Input
            id="start_time"
            type="time"
            value={form.start_time}
            onChange={(e) => update("start_time", e.target.value)}
            aria-invalid={Boolean(errorFor("start_time"))}
            aria-describedby={describedBy("start_time")}
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
            onChange={(e) => update("end_time", e.target.value)}
            aria-invalid={Boolean(errorFor("end_time"))}
            aria-describedby={describedBy("end_time")}
          />
        </FieldBox>
        {props.eventVenue.name ? (
          <div className="grid gap-1 text-sm sm:col-span-2">
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
            className="sm:col-span-2"
            label="Where is the event? (needed)"
            error={errorFor("venue_details")}
            hint={props.audience === "client" ? `Venue name and address, if ${props.djName} doesn't have it yet.` : "Shown because the event has no venue yet. Adding one on the event page also satisfies this."}
          >
            <Textarea
              id="venue_details"
              rows={2}
              value={form.venue_details}
              onChange={(e) => update("venue_details", e.target.value)}
              aria-invalid={Boolean(errorFor("venue_details"))}
              aria-describedby={describedBy("venue_details")}
            />
          </FieldBox>
        )}
        <FieldBox id="venue_room" className="sm:col-span-2" label="Room or space within the venue (optional)" error={errorFor("venue_room")}>
          <Input id="venue_room" value={form.venue_room} onChange={(e) => update("venue_room", e.target.value)} aria-describedby={describedBy("venue_room")} />
        </FieldBox>
        <FieldBox
          id="access_notes"
          className="sm:col-span-2"
          label="Parking, loading and access for the DJ (needed)"
          error={errorFor("access_notes")}
          hint={`Stairs, elevators, loading doors, parking or set-up times. If there is nothing to know, check the box below.`}
        >
          <Textarea
            id="access_notes"
            rows={3}
            value={form.access_notes}
            onChange={(e) => update("access_notes", e.target.value)}
            aria-invalid={Boolean(errorFor("access_notes"))}
            aria-describedby={describedBy("access_notes")}
          />
        </FieldBox>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={form.access_notes_none}
            onChange={(e) => update("access_notes_none", e.target.checked)}
          />
          No special instructions
        </label>
      </fieldset>
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role={alerting ? "alert" : "status"} className={alerting ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {status[saveState]}
          </p>
          {saveState === "error" || saveState === "signed_out" ? (
            <Button type="button" size="sm" variant="outline" onClick={retry}>Retry saving</Button>
          ) : null}
          {saveState === "signed_out" ? (
            <a className="text-sm underline" href="/login" target="_blank" rel="noopener">Sign in (new tab)</a>
          ) : null}
          {saveState === "conflict" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>Reload</Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Answers save automatically. Saving these never changes the contract, its price or payments
        {props.audience === "client" ? "" : `, and ${you} sees the same answers`}.
      </p>
    </div>
  );
}

function FieldBox({ id, label, hint, error, className, children }: { id: string; label: string; hint?: string; error: string | null; className?: string; children: React.ReactNode }) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
