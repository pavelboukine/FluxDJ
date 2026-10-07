"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { setClientArchived } from "../actions";

/** Archive (after a confirmation that says what changes) or restore a client. Nothing is deleted. */
export function ClientArchivePanel({ slug, clientId, name, archived, events }: { slug: string; clientId: string; name: string; archived: boolean; events: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(next: boolean) {
    start(async () => {
      const result = await setClientArchived(slug, clientId, next);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {archived ? (
        <div>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={pending}>{pending ? "Restoring…" : "Restore client"}</Button>
        </div>
      ) : confirming ? (
        <div role="dialog" aria-label="Confirm archiving the client" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Archive {name}?</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>They&apos;re hidden from the clients list (unless you include archived) and can&apos;t be chosen for new events or contacts.</li>
            <li>
              {events > 0 ? `Their ${events === 1 ? "event stays" : `${events} events stay`} as ${events === 1 ? "it is" : "they are"}, with them as a contact.` : "They have no events."}{" "}
              Proposals, contracts, signed documents and any client sign-in are unchanged.
            </li>
            <li>While archived, a proposal can&apos;t be sent to them as primary contact, and a contract can&apos;t be sent to them as signer.</li>
          </ul>
          <p className="text-muted-foreground">Nothing is deleted. You can restore them at any time.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(true)} disabled={pending}>{pending ? "Archiving…" : "Archive client"}</Button>
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
