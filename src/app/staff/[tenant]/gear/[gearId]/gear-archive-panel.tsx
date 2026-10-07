"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { setGearActive } from "../actions";

/** Archive (after a confirmation that says what changes) or restore a gear item. Nothing is deleted. */
export function GearArchivePanel({ slug, gearId, name, active, uses }: { slug: string; gearId: string; name: string; active: boolean; uses: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(next: boolean) {
    start(async () => {
      const result = await setGearActive(slug, gearId, next);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {!active ? (
        <div>
          <Button type="button" variant="outline" onClick={() => run(true)} disabled={pending}>{pending ? "Restoring…" : "Restore gear item"}</Button>
        </div>
      ) : confirming ? (
        <div role="dialog" aria-label="Confirm archiving the gear item" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Archive {name}?</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>It&apos;s hidden from the gear list (unless you include archived) and can&apos;t be picked for packages, add-ons or rules.</li>
            {uses > 0 ? (
              <li className="text-foreground">
                It&apos;s still used in {uses} place{uses === 1 ? "" : "s"} (see Used in). Proposals that include it can&apos;t be previewed or sent until you
                remove it there or restore it.
              </li>
            ) : null}
            <li>Proposals already sent keep its details, price and photos.</li>
          </ul>
          <p className="text-muted-foreground">Nothing is deleted. You can restore it at any time.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(false)} disabled={pending}>{pending ? "Archiving…" : "Archive gear item"}</Button>
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
