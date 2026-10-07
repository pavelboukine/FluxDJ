"use client";

import { useState } from "react";
import { ActionForm } from "@/components/app/action-form";
import { CheckboxField, TextAreaField, TextField } from "@/components/app/fields";
import type { ActionState } from "@/lib/forms";

/**
 * Records a received payment. Each payment gets its own idempotency key, so a
 * retry or double submit records it once; after a successful save the next
 * payment starts with a fresh key. Fields typed during a pending save are kept.
 */
export function RecordPaymentForm({
  action,
  today,
  currency,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  today: string;
  currency: string;
}) {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <ActionForm action={action} submitLabel="Record payment" pendingLabel="Recording…" resetOnSuccess trackUnsaved onSuccess={() => setKey(crypto.randomUUID())} className="sm:grid-cols-2">
      {/* Remounted with each new key, so a form reset can't restore an old one. */}
      <input key={key} type="hidden" name="idempotency_key" defaultValue={key} />
      <TextField label={`Amount received (${currency})`} name="amount" inputMode="decimal" required placeholder="500.00" autoComplete="off" />
      <TextField label="Date received" name="paid_on" type="date" required defaultValue={today} max={today} />
      <TextField label="Reference (optional)" name="reference" maxLength={200} hint="For example an invoice or e-transfer number. Staff only." autoComplete="off" />
      <TextAreaField label="Internal note (optional)" name="note" maxLength={2000} rows={2} hint="Staff only, never shown to the client." />
      <CheckboxField
        name="confirm_duplicate"
        label="This is a separate payment, even if one with the same amount and date is already recorded"
      />
    </ActionForm>
  );
}
