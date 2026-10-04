"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ActionForm, FormMessage } from "@/components/app/action-form";
import { TextAreaField } from "@/components/app/fields";
import { idleState, type ActionState } from "@/lib/forms";
import { resendContract, voidContract } from "../actions";

/** Resend (fresh invitation, previous one revoked) and void (with a reason) for a sent contract. */
export function SentControls({ slug, contractId }: { slug: string; contractId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const [voiding, setVoiding] = useState(false);

  function resend() {
    start(async () => {
      const result = await resendContract(slug, contractId);
      setState(result);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-2">
        <div>
          <Button type="button" variant="outline" onClick={resend} disabled={pending}>{pending ? "Resending…" : "Resend invitation"}</Button>
        </div>
        <p className="text-xs text-muted-foreground">Sends a new invitation link and disables the previous one. The contract itself doesn&apos;t change.</p>
        <FormMessage state={state} />
      </div>
      {voiding ? (
        <div role="dialog" aria-label="Void the contract" className="grid gap-2 rounded-xl border-2 border-destructive/40 p-4">
          <p className="font-medium">Void this contract?</p>
          <p className="text-muted-foreground">
            The client can no longer read it and its links stop working. They get an email saying the contract was withdrawn and you will
            follow up; your reason is not included. It is kept as history, and you can then generate a replacement.
          </p>
          <ActionForm action={voidContract.bind(null, slug, contractId)} submitLabel="Void contract" variant="destructive" navigateOnSuccess={`/staff/${slug}/contracts/${contractId}`}>
            <TextAreaField label="Reason (kept in the record)" name="reason" required maxLength={500} rows={2} />
          </ActionForm>
        </div>
      ) : (
        <div>
          <Button type="button" variant="destructive" onClick={() => setVoiding(true)}>Void…</Button>
        </div>
      )}
    </div>
  );
}
