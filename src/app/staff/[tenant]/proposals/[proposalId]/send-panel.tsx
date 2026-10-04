"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useDraftEditorState } from "@/components/app/draft-version";
import { FormMessage } from "@/components/app/action-form";
import { TaxSetupLink } from "@/components/app/tax-setup-link";
import { idleState, type ActionState } from "@/lib/forms";
import { sendProposal } from "../actions";

type Props = {
  slug: string;
  proposalId: string;
  version: number;
  revision: number;
  recipient: { name: string; email: string } | null;
  event: { title: string; event_date: string };
  expiryDays: number | null;
  notReadyReason: string | null;
  replacesSentOffer: boolean;
};

/** Review-then-confirm send. Requires a saved, valid draft and a primary contact. */
export function SendPanel(props: Props) {
  const router = useRouter();
  const editor = useDraftEditorState();
  // When the confirmation opened; the shown deadline is relative to it.
  const [confirmingAt, setConfirmingAt] = useState<number | null>(null);
  const confirming = confirmingAt !== null;
  const setConfirming = (open: boolean) => setConfirmingAt(open ? Date.now() : null);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  const unsaved = editor?.unsaved ?? false;
  const blocked = !props.recipient
    ? "Add a primary contact to the event before sending."
    : props.notReadyReason
      ? `Fix the offer before sending. ${props.notReadyReason}`
      : unsaved
        ? "Save your changes before sending."
        : null;
  const expiresOn =
    props.expiryDays === null || confirmingAt === null
      ? null
      : new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(confirmingAt + props.expiryDays * 86_400_000));

  function send() {
    const version = Math.max(props.version, editor?.version.current ?? props.version);
    start(async () => {
      const result = await sendProposal(props.slug, props.proposalId, version);
      setState(result);
      if (result.status === "success") router.refresh();
      else setConfirming(false);
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {blocked ? (
        <p role="status" className="text-amber-700 dark:text-amber-400">
          {blocked} <TaxSetupLink slug={props.slug} message={blocked} />
        </p>
      ) : null}
      {confirming && !blocked ? (
        <div role="dialog" aria-label="Confirm sending" className="grid gap-3 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Send this proposal?</p>
          <dl className="grid gap-1">
            <div className="flex flex-wrap gap-2"><dt className="text-muted-foreground">Recipient:</dt><dd>{props.recipient!.name} ({props.recipient!.email})</dd></div>
            <div className="flex flex-wrap gap-2"><dt className="text-muted-foreground">Event:</dt><dd>{props.event.title} · {props.event.event_date}</dd></div>
            <div className="flex flex-wrap gap-2"><dt className="text-muted-foreground">Expires:</dt><dd>{expiresOn} ({props.expiryDays} days after sending)</dd></div>
            <div className="flex flex-wrap gap-2"><dt className="text-muted-foreground">Revision:</dt><dd>{props.revision}</dd></div>
          </dl>
          <p className="text-muted-foreground">
            The offer will be frozen exactly as previewed.
            {props.replacesSentOffer ? " It replaces the offer the client has now, and their old link stops working." : ""} Sending does not
            confirm a booking.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={send} disabled={pending}>
              {pending ? "Sending…" : "Send proposal now"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={() => setConfirming(true)} disabled={Boolean(blocked)}>
            Review and send…
          </Button>
        </div>
      )}
      <FormMessage state={state} />
      {state.status === "error" ? <TaxSetupLink slug={props.slug} message={state.message} /> : null}
    </div>
  );
}
