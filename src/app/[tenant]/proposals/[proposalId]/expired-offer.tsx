"use client";

import { ProposalView, type ProposalSelectionState } from "@/components/proposal/proposal-preview";
import type { OfferSnapshot } from "@/lib/pricing";

/** Read-only view of an expired offer. */
export function ExpiredOffer(props: {
  offer: OfferSnapshot;
  mediaUrls: Record<string, string>;
  event: { title: string; event_date: string; venue_name: string | null };
  selection: ProposalSelectionState;
  djName: string;
}) {
  return (
    <ProposalView
      offer={props.offer}
      mediaUrls={props.mediaUrls}
      event={props.event}
      selection={props.selection}
      onChange={() => {}}
      readOnly
      footer={
        <p role="alert" className="rounded-2xl border p-4 text-sm font-medium text-destructive">
          This proposal has expired, so it can no longer be changed or submitted. Contact {props.djName} for a new one.
        </p>
      }
    />
  );
}
