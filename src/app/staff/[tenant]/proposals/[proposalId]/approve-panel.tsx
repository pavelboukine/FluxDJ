"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { approveSelection } from "../actions";

export function ApprovePanel({ slug, proposalId, selectionId, total }: { slug: string; proposalId: string; selectionId: string; total: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function approve() {
    start(async () => {
      const result = await approveSelection(slug, proposalId, selectionId);
      setState(result);
      if (result.status === "success") router.refresh();
      else setConfirming(false);
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {confirming ? (
        <div role="dialog" aria-label="Confirm approval" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Approve this exact selection ({total})?</p>
          <p className="text-muted-foreground">
            The client is told their contract will follow. No contract is created yet and the event is not marked as booked. To change
            anything, send a revised offer instead.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={approve} disabled={pending}>{pending ? "Approving…" : "Approve selection"}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={() => setConfirming(true)}>Approve…</Button>
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}
