import Link from "@/components/app/pending-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { SelectField } from "@/components/app/fields";
import { LinkRow } from "@/components/app/link-row";
import { ContractHistory, type loadContracts } from "../../contracts/contract-card";
import { openProposalDraft } from "../actions";

type Proposal = { id: string; revision: number; status: string; offer_frozen_at: string | null };
type Contracts = Awaited<ReturnType<typeof loadContracts>>;

const PROPOSAL_STATUS: Record<string, string> = {
  draft: "draft",
  sent: "sent",
  submitted: "submitted",
  approved: "approved",
  expired: "expired",
  declined: "declined",
  superseded: "replaced by a revision",
};
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const proposalStatus = (p: Proposal) => PROPOSAL_STATUS[p.status] ?? p.status;
const SIGNED_NOTE = "A contract has been signed for this event, so its terms can't be revised. Amendments aren't available yet.";

/** The draft and the active proposal, each once (they can be the same revision). */
const currentOf = (draft: Proposal | null, active: Proposal | null) => [draft, active].filter((p, i, all): p is Proposal => p !== null && all.indexOf(p) === i);

/** Revisions other than the draft and the active one, newest first, behind a disclosure (#proposal-history). */
function ProposalHistory({ slug, proposals, className }: { slug: string; proposals: Proposal[]; className?: string }) {
  if (proposals.length === 0) return null;
  return (
    <Disclosure id="proposal-history" summary={`Proposal history (${proposals.length})`} className={className}>
      <ul className="grid gap-1">
        {proposals.map((p) => (
          <li key={p.id}>
            <Link className="underline active:opacity-70" href={`/staff/${slug}/proposals/${p.id}`}>Revision {p.revision}</Link>
            <span className="text-muted-foreground"> · {proposalStatus(p)}{p.offer_frozen_at ? " · offer frozen" : ""}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/**
 * The proposal while the event is being booked (#proposal): the draft and the
 * active revision, starting a proposal or a revised offer, and the history.
 */
export function ProposalCard({
  slug,
  eventId,
  draft,
  active,
  older,
  hasSignedContract,
  archived,
  revising,
  templates,
}: {
  slug: string;
  eventId: string;
  draft: Proposal | null;
  active: Proposal | null;
  older: Proposal[];
  hasSignedContract: boolean;
  archived: boolean;
  /** The event already has an active proposal, so a new draft is a revised offer. */
  revising: boolean;
  templates: { id: string; name: string }[];
}) {
  return (
    <Card id="proposal" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Proposal</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {hasSignedContract ? <p role="status">{SIGNED_NOTE}</p> : null}
        {draft || active ? (
          <ul className="grid gap-1.5">
            {currentOf(draft, active).map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                <Link className="font-medium underline active:opacity-70" href={`/staff/${slug}/proposals/${p.id}`}>
                  {p === draft ? `Continue the draft (revision ${p.revision})` : `Revision ${p.revision}`}
                </Link>
                {p !== draft ? <span className="text-muted-foreground">{proposalStatus(p)}{p.offer_frozen_at ? " · offer frozen" : ""}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {archived && !draft && !hasSignedContract ? <p className="text-muted-foreground">Unarchive the event to start or revise an offer.</p> : null}
        {draft || hasSignedContract || archived ? null : (
          <ActionForm action={openProposalDraft.bind(null, slug, eventId)} submitLabel={revising ? "Start a revised offer" : "Start proposal draft"} pendingLabel="Opening…">
            <SelectField
              label="Start from template"
              name="template_id"
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
              placeholder={revising ? "— the current offer —" : "— blank proposal —"}
            />
          </ActionForm>
        )}
        <ProposalHistory slug={slug} proposals={older} />
      </CardContent>
    </Card>
  );
}

/**
 * The signed contract and the proposal as reference documents, once the
 * contract is signed: one row each to its own page (#contract, #proposal),
 * then both histories. Nothing here creates or changes a document; a signed
 * contract leaves nothing to generate or revise.
 */
export function DocumentsSection({ slug, draft, active, older, contracts }: { slug: string; draft: Proposal | null; active: Proposal | null; older: Proposal[]; contracts: Contracts }) {
  const { contracts: all, fmt } = contracts;
  const current = all.find((c) => c.status === "signed") ?? all.find((c) => c.status === "sent") ?? all.find((c) => c.status === "draft") ?? null;
  const proposals = currentOf(draft, active);
  const flush = "rounded-none border-0 border-t";
  return (
    <section id="documents" aria-labelledby="documents-heading" className="scroll-mt-20 overflow-hidden rounded-lg border" data-testid="documents">
      <h2 id="documents-heading" className="px-3 pt-2.5 pb-1 text-sm font-medium">Documents</h2>
      <ul className="divide-y">
        {current ? (
          <li id="contract" className="scroll-mt-20">
            <LinkRow
              className="rounded-none"
              href={`/staff/${slug}/contracts/${current.id}`}
              title="Contract"
              detail={current.status === "signed" && current.signed_at ? `${current.title} · signed ${fmt(current.signed_at)}` : current.label}
              status={capitalized(current.status)}
              testId="document-contract"
            />
          </li>
        ) : null}
        {proposals.map((p, i) => (
          <li key={p.id} id={i === 0 ? "proposal" : undefined} className="scroll-mt-20">
            <LinkRow
              className="rounded-none"
              href={`/staff/${slug}/proposals/${p.id}`}
              title={p === draft ? "Proposal draft" : "Proposal"}
              detail={`Revision ${p.revision}${p.offer_frozen_at ? " · offer frozen" : ""}`}
              status={capitalized(proposalStatus(p))}
              testId="document-proposal"
            />
          </li>
        ))}
      </ul>
      {current?.status === "signed" ? <p role="status" className="border-t px-3 py-2.5 text-xs text-muted-foreground">{SIGNED_NOTE}</p> : null}
      <ProposalHistory slug={slug} proposals={older} className={flush} />
      <ContractHistory slug={slug} contracts={all.filter((c) => c !== current)} className={flush} />
    </section>
  );
}
