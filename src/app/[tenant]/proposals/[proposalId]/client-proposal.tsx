"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, CloudOff, Loader2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProposalView, usePricing, type ProposalSelectionState } from "@/components/proposal/proposal-preview";
import { PriceLines } from "@/components/proposal/price-summary";
import type { OfferSnapshot, PricedSelection } from "@/lib/pricing";
import { brandStyle } from "@/lib/branding/colors";
import { cn } from "@/lib/utils";
import { saveSelectionDraftAction, submitSelectionAction } from "./actions";

type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

type Props = {
  slug: string;
  proposalId: string;
  djName: string;
  offer: OfferSnapshot;
  logo: { url: string; needsDarkBackground: boolean } | null;
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
 *
 * Submitting goes through a review step that opens only once the current
 * choices are saved, and editing is paused while reviewing, so what the
 * client reviews is exactly the saved draft that is submitted (the server
 * checks the draft version and prices the selection again).
 */
export function ClientProposal(props: Props) {
  const router = useRouter();
  const [selection, setSelection] = useState(props.initialSelection);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);

  const selectionRef = useRef(selection);
  const versionRef = useRef(props.initialVersion);
  const savedJson = useRef<string | null>(props.hasSavedDraft ? JSON.stringify(toDraft(props.initialSelection)) : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const reviewTop = useRef<HTMLHeadingElement>(null);

  const pricing = usePricing(props.offer, selection);

  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      await inFlight.current;
    }
    const draft = toDraft(selectionRef.current);
    const json = JSON.stringify(draft);
    if (json === savedJson.current) {
      setSaveState((s) => (s === "conflict" ? s : "saved"));
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
    if (closed || reviewing) return;
    selectionRef.current = next;
    setSelection(next);
    setSubmitErrors([]);
    setReviewError(null);
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

  useEffect(() => {
    if (reviewing) {
      window.scrollTo({ top: 0 });
      reviewTop.current?.focus();
    }
  }, [reviewing]);

  /** Saves anything pending, then opens the review only if the saved draft matches the screen. */
  async function startReview() {
    if (closed || preparing || saveState === "conflict") return;
    setReviewError(null);
    if (pricing.missing.length > 0) {
      setShowMissing(true);
      const first = document.getElementById(`q-${pricing.missing[0]}`);
      first?.scrollIntoView({ block: "start", behavior: "smooth" });
      first?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
      setReviewError(`Answer the ${pricing.missing.length === 1 ? "required question" : `${pricing.missing.length} required questions`} first.`);
      return;
    }
    if (!pricing.result.ok) {
      setReviewError("Some choices need attention before you can continue.");
      showSummary();
      return;
    }
    setPreparing(true);
    if (timer.current) clearTimeout(timer.current);
    await save();
    setPreparing(false);
    if (JSON.stringify(toDraft(selectionRef.current)) !== savedJson.current) {
      setReviewError("Your latest choices aren't saved yet, so they can't be reviewed. Retry saving, then continue.");
      showSummary();
      return;
    }
    setReviewing(true);
  }

  /** Brings the price summary (save status, retry, errors) into view and focuses what can fix the problem. */
  function showSummary() {
    window.requestAnimationFrame(() => {
      document.getElementById("price-summary")?.scrollIntoView({ block: "center", behavior: "smooth" });
      (document.getElementById("retry-save") ?? document.getElementById("review-error"))?.focus({ preventScroll: true });
    });
  }

  async function submit() {
    if (submittingRef.current || closed || !pricing.result.ok) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitErrors([]);
    // One key per attempted selection: retries and double clicks reuse it.
    idempotencyKey.current ??= crypto.randomUUID().replaceAll("-", "");
    try {
      const result = await submitSelectionAction(props.slug, props.proposalId, versionRef.current, idempotencyKey.current, toDraft(selectionRef.current));
      if (result.status === "submitted") {
        router.refresh(); // The page now shows the submitted proposal; the button stays disabled meanwhile.
        return;
      }
      if (result.status === "conflict") setSaveState("conflict");
      else if (result.status === "closed") setClosed(result.state);
      else if (result.status === "rate_limited") setSubmitErrors(["Too many attempts. Wait a minute and try again."]);
      else setSubmitErrors(result.errors.map((e) => e.message));
    } catch {
      setSubmitErrors(["Couldn't submit. Check your connection and try again. Nothing was sent."]);
    }
    submittingRef.current = false;
    setSubmitting(false);
  }

  const closedNotice = closed ? (
    <div role="alert" className="flex gap-3 rounded-2xl border-2 border-destructive/40 bg-destructive/5 p-4 text-sm">
      <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div className="grid gap-1">
        <p className="font-medium">{CLOSED_MESSAGES[closed] ?? CLOSED_MESSAGES.invalid}</p>
        {closed === "invalid" && saveState !== "saved" ? <p className="text-muted-foreground">Your most recent change was not saved.</p> : null}
        {closed === "invalid" && saveState === "saved" ? <p className="text-muted-foreground">Everything shown as saved is kept.</p> : null}
      </div>
    </div>
  ) : null;

  if (reviewing && pricing.result.ok) {
    return (
      <div style={brandStyle(props.offer.branding.brand_colors.primary)} className="mx-auto grid w-full max-w-2xl gap-5 text-sm">
        <div className="grid gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{props.event.title}</p>
          <h1 ref={reviewTop} tabIndex={-1} className="text-2xl font-semibold outline-none">
            Review your choices
          </h1>
          <p className="text-muted-foreground">These are your saved choices. Check them before sending them to {props.djName}.</p>
        </div>
        {closedNotice}
        <ReviewChoices offer={props.offer} priced={pricing.result.selection} />
        <section aria-labelledby="next-heading" className="grid gap-2 rounded-2xl bg-muted/60 p-4 sm:p-6">
          <h2 id="next-heading" className="font-semibold">
            What happens when you submit
          </h2>
          <ol className="grid list-decimal gap-1 pl-5">
            <li>{props.djName} receives your choices and reviews them. You can&apos;t change them after submitting.</li>
            <li>If {props.djName} approves them, you&apos;ll receive a contract by email.</li>
            <li>Your date is not booked yet. Submitting doesn&apos;t sign a contract, take a payment or confirm a booking.</li>
          </ol>
        </section>
        {submitErrors.length > 0 ? (
          <ul role="alert" className="grid gap-1 text-sm text-destructive">
            {submitErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        {saveState === "conflict" ? (
          <p role="alert" className="text-sm text-destructive">
            This proposal was changed in another tab or window. Reload to see the latest version before submitting.{" "}
            <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" className="min-h-11" disabled={submitting} onClick={() => setReviewing(false)}>
            Back to editing
          </Button>
          <Button
            type="button"
            className="min-h-11 px-5 text-base"
            style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}
            disabled={submitting || Boolean(closed) || saveState === "conflict"}
            onClick={() => void submit()}
          >
            {submitting ? (
              <>
                <Loader2 aria-hidden className="animate-spin" /> Submitting…
              </>
            ) : (
              "Submit proposal"
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground sm:text-right">Submit proposal sends your saved choices to {props.djName} for review.</p>
      </div>
    );
  }

  return (
    <ProposalView
      offer={props.offer}
      mediaBase={`/${props.slug}/proposals/${props.proposalId}/media`}
      logo={props.logo}
      event={props.event}
      selection={selection}
      onChange={onChange}
      readOnly={Boolean(closed) || preparing}
      showMissing={showMissing}
      asPage
      totalBar={
        closed
          ? undefined
          : {
              status: <BarStatus state={saveState} />,
              action: (
                <Button
                  type="button"
                  className="min-h-11 shrink-0 px-4"
                  style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}
                  onClick={() => void startReview()}
                  disabled={preparing || saveState === "conflict"}
                >
                  {preparing ? <Loader2 aria-hidden className="animate-spin" /> : null}
                  Review proposal
                </Button>
              ),
            }
      }
      onAccessLost={() => setClosed((c) => c ?? "invalid")}
      notice={closedNotice}
      summaryActions={
        closed ? (
          <p className="border-t pt-3 text-sm font-medium text-destructive">{CLOSED_MESSAGES[closed] ?? CLOSED_MESSAGES.invalid}</p>
        ) : (
          <div className="grid gap-3 border-t pt-3">
            <SaveStatus state={saveState} message={saveMessage} onRetry={() => void save()} />
            {reviewError ? (
              <p id="review-error" role="alert" tabIndex={-1} className="text-sm font-medium text-destructive outline-none">
                {reviewError}
              </p>
            ) : null}
            <Button
              type="button"
              className="min-h-11 text-base"
              style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}
              onClick={() => void startReview()}
              disabled={preparing || saveState === "conflict"}
            >
              {preparing ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" /> Saving…
                </>
              ) : (
                "Review proposal"
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              You&apos;ll see everything before it&apos;s sent. Submitting sends your choices to {props.djName} for review. It is not a booking and nothing is charged.
            </p>
            <p className="text-xs text-muted-foreground">Offer valid until {formatDeadline(props.expiresAt)}.</p>
          </div>
        )
      }
    />
  );
}

function SaveStatus({ state, message, onRetry }: { state: SaveState; message: string | null; onRetry: () => void }) {
  const problem = state === "error" || state === "conflict";
  const text = {
    saved: "All changes saved",
    unsaved: "Unsaved changes",
    saving: "Saving…",
    error: message ?? "Couldn't save your changes.",
    conflict: "This proposal was changed in another tab or window. Reload to see the latest version before continuing.",
  }[state];
  const Icon = state === "saved" ? Check : state === "saving" ? Loader2 : state === "unsaved" ? PencilLine : CloudOff;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role={problem ? "alert" : "status"} className={cn("flex items-center gap-1.5 text-sm", problem ? "font-medium text-destructive" : "text-muted-foreground")}>
        <Icon aria-hidden className={cn("size-4 shrink-0", state === "saving" && "animate-spin", state === "saved" && "text-emerald-600")} />
        {text}
      </p>
      {state === "error" ? (
        <Button id="retry-save" type="button" size="sm" variant="outline" onClick={onRetry}>
          Retry saving
        </Button>
      ) : null}
      {state === "conflict" ? (
        <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      ) : null}
    </div>
  );
}

/** The bar's save indicator: nothing once saved, never "saved" for a pending or failed save. */
function BarStatus({ state }: { state: SaveState }) {
  if (state === "saved") return null;
  const text = { unsaved: "Unsaved changes", saving: "Saving…", error: "Not saved. Retry in the summary.", conflict: "Changed in another tab. Reload." }[state];
  return <span className={cn(state === "error" || state === "conflict" ? "font-medium text-destructive" : "text-muted-foreground")}>{text}</span>;
}

/** The review: the selected package, chargeable additions, subtotal, taxes and total, then the answers. */
function ReviewChoices({ offer, priced }: { offer: OfferSnapshot; priced: PricedSelection }) {
  const pkg = offer.packages.find((p) => p.key === priced.package_key);
  const answered = offer.questions.filter((q) => q.key in priced.logistics_answers);
  const answerText = (key: string) => {
    const value = priced.logistics_answers[key];
    const question = offer.questions.find((q) => q.key === key);
    const label = (v: unknown) => question?.options.find((o) => o.value === v)?.label ?? String(v);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.length ? value.map(label).join(", ") : "None";
    return label(value);
  };
  return (
    <>
      <section aria-labelledby="review-package" className="grid gap-1 rounded-2xl border p-4 sm:p-6">
        <h2 id="review-package" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Selected package
        </h2>
        <p className="text-lg font-semibold">{pkg?.name}</p>
        {pkg?.description ? <p className="text-muted-foreground">{pkg.description}</p> : null}
      </section>
      <section aria-labelledby="review-price" className="grid gap-3 rounded-2xl border-2 p-4 sm:p-6" style={{ borderColor: "var(--brand)" }}>
        <h2 id="review-price" className="text-base font-semibold">
          Your price
        </h2>
        <PriceLines priced={priced} />
      </section>
      {answered.length > 0 ? (
        <details className="rounded-2xl border">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium">Your answers ({answered.length})</summary>
          <dl className="grid gap-2 border-t p-4">
            {answered.map((q) => (
              <div key={q.key} className="grid gap-0.5 sm:grid-cols-2 sm:gap-3">
                <dt className="text-muted-foreground">{q.prompt}</dt>
                <dd className="break-words whitespace-pre-line">{answerText(q.key)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </>
  );
}
