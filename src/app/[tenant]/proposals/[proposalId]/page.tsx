import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { frozenOfferMediaUrls, loadClientView, SLUG_PATTERN, type ClientView } from "@/lib/proposals/client-session.server";
import { recommendedSelection, type ProposalSelectionState } from "@/lib/pricing";
import { SelectionSummary } from "@/components/proposal/selection-summary";
import { ClientProposal } from "./client-proposal";
import { ExpiredOffer } from "./expired-offer";

export const metadata: Metadata = { title: "Your proposal", robots: { index: false, follow: false }, referrer: "no-referrer" };

async function brandName(slug: string): Promise<string> {
  if (!SLUG_PATTERN.test(slug)) return "your DJ";
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  return (data as { display_name?: string } | null)?.display_name ?? "your DJ";
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-4 py-16 text-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

function initialSelection(view: Extract<ClientView, { proposal: unknown }>): ProposalSelectionState {
  const recommended = recommendedSelection(view.proposal.offer);
  const draft = view.selectionDraft;
  if (!draft) return recommended;
  return {
    package_key: draft.package_key ?? recommended.package_key,
    addons: Object.fromEntries(view.proposal.offer.addons.map((a) => [a.gear_key, draft.addon_quantities[a.gear_key] ?? 0])),
    answers: draft.logistics_answers,
  };
}

/**
 * The client's proposal. Access comes only from the proposal session cookie,
 * checked in the database on every request. No account is involved, and this
 * page never grants signing, event or planning access.
 */
export default async function ClientProposalPage({ params }: PageProps<"/[tenant]/proposals/[proposalId]">) {
  const { tenant: slug, proposalId } = await params;
  const view = await loadClientView(slug, proposalId);

  if (view.state === "superseded") {
    return (
      <Notice title="A newer proposal is available">
        <p>{await brandName(slug)} has sent you an updated proposal. Please open the link in your most recent email.</p>
      </Notice>
    );
  }
  if (view.state === "unavailable") {
    return (
      <Notice title="This proposal is temporarily unavailable">
        <p>It can&apos;t be opened right now. Please try again later or contact your DJ.</p>
      </Notice>
    );
  }
  if (view.state === "invalid") {
    return (
      <Notice title="This link isn't available">
        <p>
          This proposal link is not valid or your session has ended. Open the proposal again from the link in your email, or contact{" "}
          {await brandName(slug)}.
        </p>
      </Notice>
    );
  }

  const offer = view.proposal.offer;
  const mediaUrls = await frozenOfferMediaUrls(offer);
  const dj = view.tenant.display_name;
  const brand = offer.branding.brand_colors;
  const style = { "--brand": brand.primary ?? "#111827" } as CSSProperties;

  if (view.state === "submitted" || view.state === "approved") {
    return (
      <main style={style} className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
        <header className="grid gap-2 rounded-2xl p-5 text-white" style={{ background: "var(--brand)" }}>
          <p className="text-xs tracking-wide uppercase opacity-80">{dj}</p>
          <h1 className="text-xl font-semibold">{view.event.title}</h1>
          <p className="opacity-90">{view.event.event_date}{view.event.venue_name ? ` · ${view.event.venue_name}` : ""}</p>
        </header>
        <section role="status" className="grid gap-1 rounded-2xl border-2 p-4" style={{ borderColor: "var(--brand)" }}>
          {view.state === "approved" ? (
            <>
              <p className="text-lg font-semibold">Approved by {dj}.</p>
              <p className="text-sm text-muted-foreground">Your contract will follow. Your booking is not confirmed until the contract is completed.</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold">Submitted for DJ review.</p>
              <p className="text-sm text-muted-foreground">{dj} will review your selection and get back to you. This is not a booking yet.</p>
            </>
          )}
        </section>
        {view.submission ? <SelectionSummary offer={offer} selection={view.submission.selection} /> : null}
      </main>
    );
  }

  const selection = initialSelection(view);
  const event = { title: view.event.title, event_date: view.event.event_date, venue_name: view.event.venue_name };
  return (
    <main className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-6">
      {view.state === "expired" ? (
        <ExpiredOffer offer={offer} mediaUrls={mediaUrls} event={event} selection={selection} djName={dj} />
      ) : (
        <ClientProposal
          slug={slug}
          proposalId={view.proposal.id}
          djName={dj}
          offer={offer}
          mediaUrls={mediaUrls}
          event={event}
          expiresAt={view.proposal.expires_at}
          initialSelection={selection}
          initialVersion={view.selectionDraft?.version ?? 0}
          hasSavedDraft={view.selectionDraft !== null}
        />
      )}
    </main>
  );
}
