"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";

/**
 * Archive or restore one rule. Archiving takes effect for proposals
 * previewed or sent from now on; nothing is deleted.
 */
export function RuleToggle({ action, active, label }: { action: () => Promise<ActionState>; active: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>(idleState);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={`${active ? "Archive" : "Restore"} rule: ${label}`}
        onClick={() =>
          start(async () => {
            let result: ActionState;
            try {
              result = await action();
            } catch {
              result = { status: "error", message: "That didn't go through. Check your connection, then try again." };
            }
            setState(result);
            if (result.status === "success") router.refresh();
          })
        }
      >
        {pending ? (active ? "Archiving…" : "Restoring…") : active ? "Archive" : "Restore"}
      </Button>
      <FormMessage state={state} />
    </span>
  );
}
