"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProposalView, type ProposalSelectionState } from "@/components/proposal/proposal-preview";
import { priceSelection, type OfferSnapshot } from "@/lib/pricing";
import { saveSelectionDraftAction, submitSelectionAction } from "./actions";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

type Props = {
  slug: string;
  proposalId: string;
  djName: string;
  offer: OfferSnapshot;
  mediaUrls: Record<string, string>;
  event: { title: string; event_date: string; venue_name: string | null };
  expiresAt: string;
  initialSelection: ProposalSelectionState;
  initialVersion: number;
  hasSavedDraft: boolean;
};

const AUTOSAVE_DELAY_MS = 700;

const CLOSED_MESSAGES: Record<string, string> = {
  expired: "This proposal has expired, so it can no longer be changed or submitted. Contact your DJ for a new one.",
  superseded: "A newer version of this proposal has been sent. Please open the link in your most recent email.",
  submitted: "This proposal has already been submitted for review.",
  approved: "This proposal has already been approved.",
  invalid: "Your session has ended. Open the proposal again from the link in your email.",
  unavailable: "This proposal is temporarily unavailable, so your latest change wasn't saved. Please try again later or contact your DJ.",
};

function toDraft(selection: ProposalSelectionState) {
  return { package_key: selection.package_key, addons: selection.addons, answers: selection.answers };
}

function formatDeadline(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));
}

/**
 * The client's editable proposal. The selection lives in React state, so
 * edits made while a save is in flight are never lost. Autosave sends the
 * latest selection with the last saved version (one save at a time); if the
 * selection changed meanwhile, another save follows. Conflicts (another tab
 * or window) and failures are shown and never overwrite newer input.
 */
export function ClientProposal(props: Props) {
  const router = useRouter();
  const [selection, setSelection] = useState(props.initialSelection);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);

  const selectionRef = useRef(selection);
  const versionRef = useRef(props.initialVersion);
  const savedJson = useRef<string | null>(props.hasSavedDraft ? JSON.stringify(toDraft(props.initialSelection)) : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const pricing = useMemo(() => priceSelection(props.offer, toDraft(selection)), [props.offer, selection]);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      await inFlight.current;
    }
    const draft = toDraft(selectionRef.current);
    const json = JSON.stringify(draft);
    if (json === savedJson.current) {
      setSaveState("saved");
      return;
    }
    const run = (async () => {
      setSaveState("saving");
      setSaveMessage(null);
      try {
        const result = await saveSelectionDraftAction(props.slug, props.proposalId, versionRef.current, draft);
        if (result.status === "ok") {
          versionRef.current = result.version;
          savedJson.current = json;
          const newer = JSON.stringify(toDraft(selectionRef.current)) !== json;
          setSaveState(newer ? "unsaved" : "saved");
          if (newer) timer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
        } else if (result.status === "conflict") {
          setSaveState("conflict");
        } else if (result.status === "closed") {
          setClosed(result.state);
        } else {
          setSaveState("error");
          setSaveMessage(result.status === "rate_limited" ? "Too many changes too quickly. Wait a moment, then retry." : "Some choices could not be saved. Check them and retry.");
        }
      } catch {
        setSaveState("error");
        setSaveMessage("Couldn't save your changes. Check your connection and retry. Your choices are still here.");
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, [props.slug, props.proposalId]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  function onChange(next: ProposalSelectionState) {
    if (closed) return;
    selectionRef.current = next;
    setSelection(next);
    setSubmitErrors([]);
    idempotencyKey.current = null; // A changed selection is a new submission.
    if (saveState !== "conflict") setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }

  // Expiry while the page is open: stop editing when the deadline passes (the server refuses too).
  useEffect(() => {
    const remaining = Date.parse(props.expiresAt) - Date.now();
    const handle = setTimeout(() => setClosed("expired"), Math.max(0, Math.min(remaining, 2_147_000_000)));
    return () => clearTimeout(handle);
  }, [props.expiresAt]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function submit() {
    if (submitting || closed || !pricing.ok) return;
    setSubmitting(true);
    setSubmitErrors([]);
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    // One key per attempted selection: retries and double clicks reuse it.
    idempotencyKey.current ??= crypto.randomUUID().replaceAll("-", "");
    try {
      const result = await submitSelectionAction(props.slug, props.proposalId, versionRef.current, idempotencyKey.current, toDraft(selectionRef.current));
      if (result.status === "submitted") {
        router.refresh();
        return;
      }
      if (result.status === "conflict") setSaveState("conflict");
      else if (result.status === "closed") setClosed(result.state);
      else if (result.status === "rate_limited") setSubmitErrors(["Too many attempts. Wait a minute and try again."]);
      else setSubmitErrors(result.errors.map((e) => e.message));
      setSubmitting(false);
    } catch {
      setSubmitErrors(["Couldn't submit. Check your connection and try again."]);
      setSubmitting(false);
    }
  }

  const status = {
    saved: "All changes saved",
    unsaved: "Unsaved changes",
    saving: "Saving…",
    error: saveMessage ?? "Couldn't save your changes.",
    conflict: "This proposal was changed in another tab or window. Reload to see the latest version before continuing.",
  }[saveState];

  return (
    <ProposalView
      offer={props.offer}
      mediaUrls={props.mediaUrls}
      event={props.event}
      selection={selection}
      onChange={onChange}
      readOnly={Boolean(closed) || submitting}
      footer={
        <section aria-label="Save and submit" className="grid gap-3 rounded-2xl border p-4">
          {closed ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {CLOSED_MESSAGES[closed] ?? CLOSED_MESSAGES.invalid}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <p
                  role={saveState === "error" || saveState === "conflict" ? "alert" : "status"}
                  className={saveState === "error" || saveState === "conflict" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
                >
                  {status}
                </p>
                {saveState === "error" ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void save()}>
                    Retry saving
                  </Button>
                ) : null}
                {saveState === "conflict" ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">Offer valid until {formatDeadline(props.expiresAt)}.</p>
              {!pricing.ok ? (
                <p className="text-sm text-muted-foreground">Answer the required questions to submit your selection.</p>
              ) : null}
              {submitErrors.length > 0 ? (
                <ul role="alert" className="text-sm text-destructive">
                  {submitErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
              <Button type="button" onClick={() => void submit()} disabled={!pricing.ok || submitting || saveState === "conflict"}>
                {submitting ? "Submitting…" : `Submit for ${props.djName} to review`}
              </Button>
              <p className="text-xs text-muted-foreground">
                Submitting sends your selection to {props.djName} for review. It is not a booking and nothing is charged.
              </p>
            </>
          )}
        </section>
      }
    />
  );
}
