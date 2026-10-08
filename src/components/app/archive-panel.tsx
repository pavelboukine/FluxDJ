"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";

/**
 * Archive (after a confirmation listing what changes) or restore a record,
 * separate from saving its details. Nothing is deleted.
 */
export function ArchivePanel({
  noun,
  name,
  archived,
  action,
  effects,
}: {
  /** "template", "question". */
  noun: string;
  name: string;
  archived: boolean;
  /** The bound server action: archive (true) or restore (false). */
  action: (archived: boolean) => Promise<ActionState>;
  /** What archiving changes, one point each. */
  effects: ReactNode[];
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(next: boolean) {
    start(async () => {
      let result: ActionState;
      try {
        result = await action(next);
      } catch {
        result = { status: "error", message: "That didn't go through. Check your connection, then try again." };
      }
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {archived ? (
        <div>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={pending}>{pending ? "Restoring…" : `Restore ${noun}`}</Button>
        </div>
      ) : confirming ? (
        <div role="dialog" aria-label={`Confirm archiving the ${noun}`} className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium [overflow-wrap:anywhere]">Archive {name}?</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            {effects.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">Nothing is deleted. You can restore it at any time.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(true)} disabled={pending}>{pending ? "Archiving…" : `Archive ${noun}`}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>Archive…</Button>
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}
