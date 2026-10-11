"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import type { ActionState } from "@/lib/forms";

/**
 * Invite one staff member. The request id is made once per form, so a retry
 * of the same submission can't create a second invitation; after a success,
 * "Invite someone else" starts a new form (and a new id).
 */
export function InviteStaffForm({ action }: { action: (state: ActionState, form: FormData) => Promise<ActionState> }) {
  const [round, setRound] = useState(0);
  const [sent, setSent] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="grid gap-3 text-sm">
        <p role="status" className="text-emerald-700 dark:text-emerald-400">{sent}</p>
        <div>
          <Button type="button" variant="outline" onClick={() => { setSent(null); setRound((n) => n + 1); }}>
            Invite someone else
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ActionForm
      key={round}
      action={action}
      submitLabel="Send invitation"
      pendingLabel="Sending…"
      onSuccess={(result) => result.status === "success" && setSent(result.message)}
    >
      <RequestIdField />
      <TextField label="Email address" name="email" type="email" required maxLength={320} autoComplete="off" className="max-w-md" />
      <p className="text-sm">
        <span className="text-muted-foreground">Role: </span>Staff
      </p>
    </ActionForm>
  );
}
