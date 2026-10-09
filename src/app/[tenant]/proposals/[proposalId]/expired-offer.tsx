"use client";

import { Clock } from "lucide-react";
import { ProposalView, type ProposalSelectionState } from "@/components/proposal/proposal-preview";
import type { OfferSnapshot } from "@/lib/pricing";

/** Read-only view of an expired offer: the client can still look, nothing can change. */
export function ExpiredOffer(props: {
  slug: string;
  proposalId: string;
  offer: OfferSnapshot;
  logo: { url: string; needsDarkBackground: boolean } | null;
  event: { title: string; event_date: string; venue_name: string | null };
  selection: ProposalSelectionState;
  djName: string;
}) {
  return (
    <ProposalView
      offer={props.offer}
      mediaBase={`/${props.slug}/proposals/${props.proposalId}/media`}
      logo={props.logo}
      event={props.event}
      selection={props.selection}
      onChange={() => {}}
      readOnly
      asPage
      notice={
        <div role="alert" className="flex gap-3 rounded-2xl border-2 border-destructive/40 bg-destructive/5 p-4 text-sm">
          <Clock aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
          <p className="font-medium">This proposal has expired, so it can no longer be changed or submitted. Contact {props.djName} for a new one.</p>
        </div>
      }
    />
  );
}
