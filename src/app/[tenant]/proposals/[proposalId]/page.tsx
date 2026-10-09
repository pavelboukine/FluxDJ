import type { Metadata } from "next";
import { CheckCircle2, Clock, Link2Off, PauseCircle } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadClientView, SLUG_PATTERN, type ClientView } from "@/lib/proposals/client-session.server";
import { recommendedSelection, type ProposalSelectionState } from "@/lib/pricing";
import { SelectionSummary } from "@/components/proposal/selection-summary";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandStyle } from "@/lib/branding/colors";
import { frozenOfferLogo } from "@/lib/branding/logo.server";
import { shortDate } from "@/lib/dates";
import { ClientProposal } from "./client-proposal";
import { ExpiredOffer } from "./expired-offer";

export const metadata: Metadata = { title: "Your proposal", robots: { index: false, follow: false }, referrer: "no-referrer" };

async function brandName(slug: string): Promise<string> {
  if (!SLUG_PATTERN.test(slug)) return "your DJ";
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  return (data as { display_name?: string } | null)?.display_name ?? "your DJ";
}

function Notice({ title, icon: Icon, children }: { title: string; icon: typeof Clock; children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center px-4 py-16">
      <div className="grid gap-3 rounded-2xl border p-6 text-sm shadow-sm">
        <Icon aria-hidden className="size-8 text-muted-foreground" />
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
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
      <Notice title="A newer proposal is available" icon={Clock}>
        <p>{await brandName(slug)} has sent you an updated proposal. Please open the link in your most recent email.</p>
      </Notice>
    );
  }
  if (view.state === "unavailable") {
    return (
      <Notice title="This proposal is temporarily unavailable" icon={PauseCircle}>
        <p>It can&apos;t be opened right now. Please try again later or contact your DJ.</p>
      </Notice>
    );
  }
  if (view.state === "invalid") {
    return (
      <Notice title="This link isn't available" icon={Link2Off}>
        <p>This proposal link is not valid or your session has ended.</p>
        <p>
          Open the proposal again from the link in your most recent email. Choices that were shown as saved are kept. If the link no longer works, contact{" "}
          {await brandName(slug)}.
        </p>
      </Notice>
    );
  }

  const offer = view.proposal.offer;
  const logo = await frozenOfferLogo(offer);
  const dj = view.tenant.display_name;
  const style = brandStyle(offer.branding.brand_colors.primary);

  if (view.state === "submitted" || view.state === "approved") {
    const approved = view.state === "approved";
    return (
      <main style={style} className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 text-sm">
        <header className="grid gap-2 rounded-2xl p-5 sm:p-8" style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}>
          <div className="flex min-h-6 items-center">
            <BrandLogo logo={logo} name={dj} className="max-h-12 max-w-48" fallbackClassName="text-sm font-semibold tracking-wide uppercase opacity-90" />
          </div>
          <h1 className="text-2xl font-semibold text-balance">{view.event.title}</h1>
          <p className="opacity-90">
            {shortDate(view.event.event_date)}
            {view.event.venue_name ? ` · ${view.event.venue_name}` : ""}
          </p>
        </header>
        <section role="status" className="flex gap-3 rounded-2xl border-2 p-4 sm:p-5" style={{ borderColor: "var(--brand)" }}>
          <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-emerald-600" />
          <div className="grid gap-1">
            {approved ? (
              <>
                <p className="text-lg font-semibold">Approved by {dj}.</p>
                <p className="text-muted-foreground">Your contract will follow. Your booking is not confirmed until the contract is completed.</p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold">Submitted for DJ review.</p>
                <p className="text-muted-foreground">
                  {dj} will review your selection and get back to you. This is not a booking yet: nothing has been signed or charged.
                </p>
              </>
            )}
          </div>
        </section>
        {!approved ? (
          <section aria-labelledby="next-heading" className="grid gap-2 rounded-2xl bg-muted/60 p-4 sm:p-5">
            <h2 id="next-heading" className="font-semibold">
              What happens next
            </h2>
            <ol className="grid list-decimal gap-1 pl-5">
              <li>{dj} reviews your choices.</li>
              <li>If they approve them, you&apos;ll receive a contract by email.</li>
              <li>Your date is booked only once the contract is completed.</li>
            </ol>
          </section>
        ) : null}
        {view.submission ? (
          <section aria-labelledby="choices-heading" className="grid gap-3 rounded-2xl border p-4 sm:p-6">
            <h2 id="choices-heading" className="text-base font-semibold">
              Your submitted choices
            </h2>
            <SelectionSummary offer={offer} selection={view.submission.selection} />
          </section>
        ) : null}
      </main>
    );
  }

  const selection = initialSelection(view);
  const event = { title: view.event.title, event_date: view.event.event_date, venue_name: view.event.venue_name };
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6">
      {view.state === "expired" ? (
        <ExpiredOffer slug={slug} proposalId={view.proposal.id} offer={offer} logo={logo} event={event} selection={selection} djName={dj} />
      ) : (
        <ClientProposal
          slug={slug}
          proposalId={view.proposal.id}
          djName={dj}
          offer={offer}
          logo={logo}
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
