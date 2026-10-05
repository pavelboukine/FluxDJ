"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { invalidatePayment } from "../payment-actions";

/** Invalidates a wrong entry after confirmation, with a required reason. The reason stays if the request fails. */
export function InvalidatePayment({ slug, eventId, paymentId, label }: { slug: string; eventId: string; paymentId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const id = `reason-${paymentId}`;

  function confirm() {
    start(async () => {
      const result = await invalidatePayment(slug, eventId, paymentId, reason);
      setState(result);
      if (result.status === "success") {
        setOpen(false);
        router.refresh();
      }
    });
  }

  if (!open) {
    return (
      <div className="grid gap-1">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Invalidate…</Button>
        <FormMessage state={state} />
      </div>
    );
  }
  return (
    <div role="dialog" aria-label="Confirm invalidating the payment" className="grid gap-2 rounded-xl border-2 border-primary/40 p-3 text-sm">
      <p className="font-medium">Invalidate {label}?</p>
      <p className="text-muted-foreground">
        It stops counting towards the totals but stays in the history with your reason. To correct it, record the right payment as a new
        entry. This can&apos;t be undone.
      </p>
      <Label htmlFor={id}>Reason (required)</Label>
      <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={confirm} disabled={pending || reason.trim().length < 3}>{pending ? "Invalidating…" : "Invalidate payment"}</Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
      </div>
      <FormMessage state={state} />
    </div>
  );
}
