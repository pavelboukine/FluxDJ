import Link from "next/link";
import { ProposalPreview } from "@/components/proposal/proposal-preview";
import { TaxSetupLink } from "@/components/app/tax-setup-link";
import { requireStaff } from "@/lib/auth/staff";
import { loadPreview, loadProposal } from "../load";

export default async function FullPreview({ params }: PageProps<"/staff/[tenant]/proposals/[proposalId]/preview">) {
  const { tenant: slug, proposalId } = await params;
  const staff = await requireStaff(slug);
  const proposal = await loadProposal(staff, proposalId);
  const preview = await loadPreview(staff, proposal.id);
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <p role="note" className="rounded-lg bg-amber-500/15 p-3 text-sm">
        Staff preview — not sent. Resize the window or open this on a phone to check the mobile layout.{" "}
        <Link className="underline" href={`/staff/${slug}/proposals/${proposal.id}`}>Back to the builder</Link>
      </p>
      {preview.ok ? (
        <ProposalPreview offer={preview.offer} mediaUrls={preview.mediaUrls} event={proposal.events!} />
      ) : (
        <p className="text-sm">
          {preview.message} <TaxSetupLink slug={slug} message={preview.message} />
        </p>
      )}
    </div>
  );
}
