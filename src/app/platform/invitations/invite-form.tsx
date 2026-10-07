"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import type { ActionState } from "@/lib/forms";

/**
 * Two steps: type the address, then review the recipient and expiry before
 * anything is sent. The server normalizes and checks the address again.
 */
export function InviteForm({ action, days }: { action: (state: ActionState, form: FormData) => Promise<ActionState>; days: number }) {
  const [email, setEmail] = useState("");
  const [review, setReview] = useState<{ email: string; expires: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="grid gap-3 text-sm">
        <p role="status" className="text-emerald-700 dark:text-emerald-400">{sent}</p>
        <div>
          <Button type="button" variant="outline" onClick={() => { setSent(null); setReview(null); setEmail(""); }}>
            Invite another DJ
          </Button>
        </div>
      </div>
    );
  }

  if (review) {
    return (
      <div role="dialog" aria-label="Review the invitation" className="grid gap-3 rounded-xl border-2 border-primary/40 p-4 text-sm">
        <p className="font-medium">Review the invitation</p>
        <dl className="grid gap-1">
          <div><dt className="inline text-muted-foreground">Recipient: </dt><dd className="inline font-medium break-all">{review.email}</dd></div>
          <div><dt className="inline text-muted-foreground">Expires: </dt><dd className="inline">{review.expires} ({days} days)</dd></div>
        </dl>
        <p className="text-muted-foreground">
          They confirm this address, then name their business and choose its web address. Their workspace starts empty, and you get no
          access to it.
        </p>
        <ActionForm action={action} submitLabel="Send invitation" pendingLabel="Sending…" onSuccess={(result) => result.status === "success" && setSent(result.message)}>
          <input type="hidden" name="email" value={review.email} />
        </ActionForm>
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setReview(null)}>Change the email</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const value = email.trim().toLowerCase();
        const expires = new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(Date.now() + days * 86_400_000));
        if (value) setReview({ email: value, expires });
      }}
    >
      <TextField label="DJ's email address" name="email" type="email" required maxLength={320} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div>
        <Button type="submit">Review invitation</Button>
      </div>
    </form>
  );
}
