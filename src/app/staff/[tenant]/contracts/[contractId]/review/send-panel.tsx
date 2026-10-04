"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { sendContract } from "../../actions";

/** Confirm-then-send. The server re-runs every eligibility check inside the send transaction. */
export function SendPanel({ slug, contractId, canSend, reason, recipient }: { slug: string; contractId: string; canSend: boolean; reason: string | null; recipient: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function send() {
    start(async () => {
      const result = await sendContract(slug, contractId);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.push(`/staff/${slug}/contracts/${contractId}`);
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {reason ? <p role="status" className="text-muted-foreground">{reason}</p> : null}
      {confirming && canSend ? (
        <div role="dialog" aria-label="Confirm sending the contract" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Send this contract to {recipient}?</p>
          <p className="text-muted-foreground">
            The contract is sent exactly as shown and can&apos;t be edited afterwards. The client gets an email, confirms their address, then
            can read it. They can&apos;t sign yet, and the event is not booked.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={send} disabled={pending}>{pending ? "Sending…" : "Send contract now"}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={() => setConfirming(true)} disabled={!canSend}>Send contract…</Button>
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}
