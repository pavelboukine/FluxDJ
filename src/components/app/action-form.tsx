"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSharedDraftVersion } from "@/components/app/draft-version";
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
  /** Clear the fields after a successful submit (for "add another" forms). */
  resetOnSuccess?: boolean;
  /** Show whether the form has edits that have not been saved yet. */
  trackUnsaved?: boolean;
  /**
   * Navigate here after success; "{version}" is replaced with the returned
   * version. Used when a save should deliberately reload other forms.
   */
  navigateOnSuccess?: string;
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
}: Props) {
  const router = useRouter();
  const sharedVersion = useSharedDraftVersion();
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
      setDirty(snapshot(formRef.current) !== baseline.current);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (version !== undefined) {
      const expected = Math.max(version, savedVersion.current ?? version, sharedVersion?.current ?? version);
      data.set("draft_version", String(expected));
    }
    // What this submit saves; edits made while it is pending stay "unsaved".
    const submitted = snapshot(form);

    startTransition(async () => {
      const result = await action(state, data);
      setState(result);
      if (result.status !== "success") return;
      if (result.version !== undefined) {
        savedVersion.current = result.version;
        if (sharedVersion) sharedVersion.current = Math.max(sharedVersion.current, result.version);
      }
      if (navigateOnSuccess) router.replace(navigateOnSuccess.replace("{version}", String(result.version ?? "")));
      if (resetOnSuccess) {
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
