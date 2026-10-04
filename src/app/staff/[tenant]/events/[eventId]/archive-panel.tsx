"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { setEventArchived } from "../actions";

/** Archive (with confirmation) or restore an event. */
export function ArchivePanel({ slug, eventId, archived }: { slug: string; eventId: string; archived: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(next: boolean) {
    start(async () => {
      const result = await setEventArchived(slug, eventId, next);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {archived ? (
        <div>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={pending}>{pending ? "Restoring…" : "Unarchive event"}</Button>
        </div>
      ) : confirming ? (
        <div role="dialog" aria-label="Confirm archiving" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Archive this event?</p>
          <p className="text-muted-foreground">
            It is hidden from the events list and its client links stop working immediately. Proposals can&apos;t be sent or approved and
            contracts can&apos;t be generated until you unarchive it. Proposals, contracts and history are kept, and the event status does
            not change.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(true)} disabled={pending}>{pending ? "Archiving…" : "Archive event"}</Button>
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
