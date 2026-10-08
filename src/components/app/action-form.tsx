"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useDraftEditorState, useSharedDraftVersion } from "@/components/app/draft-version";
import { idleState, type ActionState } from "@/lib/forms";
import { cn } from "@/lib/utils";

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost";
  className?: string;
  /** Render the submit button inline (for small one-button forms). */
  inline?: boolean;
  /**
   * Optimistic-concurrency version, sent as the "draft_version" field. Uses
   * the newer of the page's value and the version returned by the last
   * successful save, so consecutive saves work without a reload, while a
   * genuinely stale tab still gets a conflict from the server.
   */
  version?: number;
  /** Clear the fields after a successful submit (for "add another" forms), unless edits were typed meanwhile. */
  resetOnSuccess?: boolean;
  /** Show whether the form has edits that have not been saved yet. */
  trackUnsaved?: boolean;
  /**
   * Navigate here after success; "{version}" is replaced with the returned
   * version. Used when a save should deliberately reload other forms.
   */
  navigateOnSuccess?: string;
  /** Ask for confirmation before submitting when the page's editor has unsaved changes. */
  confirmIfUnsaved?: string;
  /** Called after a successful submit (e.g. to start a fresh idempotency key). */
  onSuccess?: (result: ActionState) => void;
  /** Shown beside the submit button (e.g. a Cancel button). */
  secondary?: ReactNode;
};

/** Serializes the user-editable fields, so "unsaved changes" can be detected. */
function snapshot(form: HTMLFormElement): string {
  return JSON.stringify(
    [...new FormData(form).entries()].filter(([name, value]) => name !== "draft_version" && typeof value === "string"),
  );
}

/**
 * A form bound to a Server Action, with pending state and an accessible
 * status message.
 *
 * It submits through onSubmit instead of <form action>, because React resets
 * uncontrolled fields when a form action completes: anything typed while a
 * save was in flight would be wiped. Here fields keep whatever is on screen;
 * only "add another" forms opt in to clearing. Fields stay editable while a
 * save is pending, and a later save sends the newer values.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  variant,
  className,
  inline,
  version,
  resetOnSuccess,
  trackUnsaved,
  navigateOnSuccess,
  confirmIfUnsaved,
  onSuccess,
  secondary,
}: Props) {
  const router = useRouter();
  const sharedVersion = useSharedDraftVersion();
  const editor = useDraftEditorState();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, startTransition] = useTransition();
  const savedVersion = useRef<number | undefined>(undefined);
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (formRef.current) baseline.current = snapshot(formRef.current);
  }, []);

  function refreshDirty() {
    if (trackUnsaved && formRef.current && baseline.current !== null) {
      const next = snapshot(formRef.current) !== baseline.current;
      setDirty(next);
      editor?.setUnsaved(next);
    }
  }

  // This form unmounting (e.g. remounted after a template) leaves no unsaved edits behind.
  useEffect(() => {
    if (!trackUnsaved) return;
    return () => editor?.setUnsaved(false);
  }, [trackUnsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (confirmIfUnsaved && editor?.unsaved && !window.confirm(confirmIfUnsaved)) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (version !== undefined) {
      const expected = Math.max(version, savedVersion.current ?? version, sharedVersion?.current ?? version);
      data.set("draft_version", String(expected));
    }
    // What this submit saves; edits made while it is pending stay "unsaved".
    const submitted = snapshot(form);

    startTransition(async () => {
      let result: ActionState;
      try {
        result = await action(state, data);
      } catch (error) {
        // Navigation (a redirect after saving) continues as usual; a request
        // that never reached the server keeps everything typed, as an error.
        unstable_rethrow(error);
        result = { status: "error", message: "The save didn't go through. Check your connection, then try again." };
      }
      setState(result);
      if (result.status !== "success") return;
      if (result.version !== undefined) {
        savedVersion.current = result.version;
        if (sharedVersion) sharedVersion.current = Math.max(sharedVersion.current, result.version);
      }
      onSuccess?.(result);
      if (navigateOnSuccess) router.replace(navigateOnSuccess.replace("{version}", String(result.version ?? "")));
      // "Add another" forms clear after success, unless something was typed
      // while the save was pending: those edits are kept.
      if (resetOnSuccess && snapshot(form) === submitted) {
        form.reset();
        baseline.current = snapshot(form);
      } else {
        baseline.current = submitted;
      }
      refreshDirty();
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onInput={refreshDirty}
      onChange={refreshDirty}
      className={cn(inline ? "flex flex-wrap items-center gap-2" : "grid gap-4", className)}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} variant={variant}>
          {pending ? (pendingLabel ?? "Saving…") : submitLabel}
        </Button>
        {secondary}
        <FormMessage state={state} />
        {trackUnsaved && dirty ? (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            Unsaved changes
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={cn("text-sm", state.status === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}
    >
      {state.message}
    </p>
  );
}
