"use client";

import { useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSharedDraftVersion } from "@/components/app/draft-version";
import { idleState, type ActionState } from "@/lib/forms";
import { cn } from "@/lib/utils";

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Structure or template version, sent as "draft_version". */
  version: number;
  fields: Record<string, string>;
  submitLabel: string;
  /** Accessible name when the visible label is ambiguous ("Move Ceremony up"). */
  ariaLabel?: string;
  pendingLabel?: string;
  confirmText?: string;
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost";
  disabled?: boolean;
  /** Inputs shown before the button (e.g. a label to rename). */
  children?: ReactNode;
  className?: string;
};

/**
 * One small structure control (rename, move, hide, remove) as its own form.
 * It sends the newest known version: the page's, or the one returned by the
 * last save on this page (shared through DraftVersionProvider), so several
 * changes in a row work while another tab still gets a conflict. Typed text
 * is never reset; errors are announced next to the control.
 */
export function RowAction({ action, version, fields, submitLabel, ariaLabel, pendingLabel, confirmText, variant = "outline", disabled, children, className }: Props) {
  const shared = useSharedDraftVersion();
  const saved = useRef<number | undefined>(undefined);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const data = new FormData(event.currentTarget);
    data.set("draft_version", String(Math.max(version, saved.current ?? version, shared?.current ?? version)));
    start(async () => {
      const result = await action(state, data);
      setState(result);
      if (result.status === "success" && result.version !== undefined) {
        saved.current = result.version;
        if (shared) shared.current = Math.max(shared.current, result.version);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className={cn("flex flex-wrap items-center gap-2", className)}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <Button type="submit" size="sm" variant={variant} disabled={pending || disabled} aria-label={ariaLabel}>
        {pending ? (pendingLabel ?? "Saving…") : submitLabel}
      </Button>
      {state.status === "error" ? (
        <p role="alert" className="basis-full text-xs text-destructive">{state.message}</p>
      ) : null}
    </form>
  );
}
