"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
   * Optimistic-concurrency version sent as a hidden "draft_version" field.
   * Uses the newer of the page's value and the version returned by the last
   * successful save, so consecutive saves work without a reload.
   */
  version?: number;
};

/** A form bound to a Server Action, with pending state and an accessible status message. */
export function ActionForm({ action, children, submitLabel, pendingLabel, variant, className, inline, version }: Props) {
  const [state, formAction, pending] = useActionState(action, idleState);
  const savedVersion = state.status === "success" ? state.version : undefined;
  const currentVersion = version === undefined ? undefined : Math.max(version, savedVersion ?? version);
  return (
    <form action={formAction} className={cn(inline ? "flex flex-wrap items-center gap-2" : "grid gap-4", className)}>
      {currentVersion === undefined ? null : <input type="hidden" name="draft_version" value={currentVersion} />}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} variant={variant}>
          {pending ? (pendingLabel ?? "Saving…") : submitLabel}
        </Button>
        <FormMessage state={state} />
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
