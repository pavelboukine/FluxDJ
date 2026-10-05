"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { answersKey } from "@/lib/planning/basics";
import type { SaveItemResult } from "@/lib/planning/view";
import { usePlanProgress } from "./progress";

export type SaveState = "saved" | "unsaved" | "saving" | "invalid" | "error" | "conflict" | "signed_out" | "unavailable";
type Parsed<A> = { ok: true; answers: A } | { ok: false; field: string; message: string };

const AUTOSAVE_DELAY_MS = 800;

/**
 * Autosave for one plan item. The form lives in React state, so edits typed
 * while a save is in flight are kept; one save runs at a time, and if the
 * form changed meanwhile another follows. A stale revision (another tab or
 * window) is a conflict that never overwrites anything; failures keep every
 * input and offer Retry. Progress and timing notes come from the server's
 * answer. After a conflict or loss of access, typing stays on screen but is
 * never sent.
 */
export function useAutosave<F extends Record<string, unknown>, A extends Record<string, unknown>>(opts: {
  initialForm: F;
  initialAnswers: A;
  initialRevision: number;
  parse: (form: F) => Parsed<A>;
  save: (expectedRevision: number, answers: A) => Promise<SaveItemResult>;
  readOnly: boolean;
  onSaved?: (answers: Record<string, unknown>) => void;
}) {
  const plan = usePlanProgress();
  const [form, setForm] = useState<F>(opts.initialForm);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const formRef = useRef(form);
  const revisionRef = useRef(opts.initialRevision);
  const savedKey = useRef(answersKey(opts.initialAnswers));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const stopped = useRef(false);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) await inFlight.current;
    if (stopped.current) return;
    const { parse, save: send, onSaved } = optsRef.current;
    const parsed = parse(formRef.current);
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      setSaveState("invalid");
      return;
    }
    if (answersKey(parsed.answers) === savedKey.current) {
      setSaveState("saved");
      return;
    }
    const run = (async () => {
      setSaveState("saving");
      setMessage(null);
      try {
        const result = await send(revisionRef.current, parsed.answers);
        switch (result.status) {
          case "saved": {
            revisionRef.current = result.revision;
            savedKey.current = answersKey(result.answers);
            plan?.applySaved(result);
            onSaved?.(result.answers);
            const now = parse(formRef.current);
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
  }, [plan]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** Changes fields; `clears` names other fields whose error this change resolves. */
  function update(changes: Partial<F>, clears: string[] = []) {
    if (optsRef.current.readOnly) return;
    const next = { ...formRef.current, ...changes };
    formRef.current = next;
    setForm(next);
    if (fieldError && (fieldError.field in changes || clears.includes(fieldError.field))) setFieldError(null);
    if (stopped.current) return;
    setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
  }

  function retry() {
    if (timer.current) clearTimeout(timer.current);
    void save();
  }

  return { form, update, saveState, message, fieldError, retry };
}

const STATUS: Record<SaveState, string> = {
  saved: "All changes saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  invalid: "Fix the highlighted answer to save.",
  error: "Couldn't save your changes.",
  conflict: "These answers were changed in another tab or window. Reload to see the latest before continuing. Your typing here is not saved.",
  signed_out: "Your session has ended. Sign in again in a new tab, then retry. Your answers are still here.",
  unavailable: "This section isn't available for editing any more (hidden, archived or no access). Your answers on this page were not saved.",
};

/** The save status line with Retry, sign-in and Reload actions. */
export function SaveStatus({ saveState, message, retry }: { saveState: SaveState; message: string | null; retry: () => void }) {
  const alerting = saveState !== "saved" && saveState !== "unsaved" && saveState !== "saving";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role={alerting ? "alert" : "status"} className={alerting ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {saveState === "error" && message ? message : STATUS[saveState]}
      </p>
      {saveState === "error" || saveState === "signed_out" ? (
        <Button type="button" size="sm" variant="outline" onClick={retry}>Retry saving</Button>
      ) : null}
      {saveState === "signed_out" ? <a className="text-sm underline" href="/login" target="_blank" rel="noopener">Sign in (new tab)</a> : null}
      {saveState === "conflict" ? (
        <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>Reload</Button>
      ) : null}
    </div>
  );
}
