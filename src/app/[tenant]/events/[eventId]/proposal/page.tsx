import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BrandLogo } from "@/components/app/brand-logo";
import { ClientHeader } from "@/components/app/client-header";
import { SelectionSummary } from "@/components/proposal/selection-summary";
import { signOut } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";
import { eventHubPath } from "@/lib/client-event";
import { loadClientEvents } from "@/lib/client-event.server";
import { dateIn } from "@/lib/dates";
import { UUID_RE } from "@/lib/forms";
import { formatEventDate } from "@/lib/planning/view";
import type { OfferSnapshot, PricedSelection } from "@/lib/pricing";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your approved proposal", robots: { index: false, follow: false }, referrer: "strict-origin" };

type Approved =
  | { state: "unavailable" }
  | {
      state: "available";
      event_id: string;
      contract: { id: string; status: "sent" | "signed" };
      proposal: { revision: number; offer: OfferSnapshot };
      selection: { version: number; submitted_at: string | null; priced: PricedSelection };
      approved_at: string;
    };

const SHEET = "grid min-w-0 content-start gap-4 border-plan-hairline bg-plan-surface p-4 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-6";

/**
 * The proposal the client agreed to, read-only: the frozen offer and the exact approved selection their contract
 * was built from (client_approved_offer, for the contract's signer only), never a newer revision or today's
 * catalogue prices. Package photos are left out: they are served only to a proposal link's own session.
 */
export default async function ApprovedProposal({ params }: PageProps<"/[tenant]/events/[eventId]/proposal">) {
  const { tenant: slug, eventId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(eventId)) notFound();
  const hub = eventHubPath(slug, eventId);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(loginHref("client", `${hub}/proposal`));

  const [facts] = await loadClientEvents(supabase, { slug, eventId });
  const { data } = facts?.contract ? await supabase.rpc("client_approved_offer", { p_contract_id: facts.contract.id, p_tenant_slug: slug }) : { data: null };
  const approved = (data as Approved | null) ?? { state: "unavailable" };
  if (!facts || approved.state !== "available" || approved.event_id !== eventId) {
    return (
      <div data-plan-shell className="min-h-dvh bg-plan-canvas">
        <ClientHeader email={auth.user.email ?? null} back={facts ? { href: hub, label: "Your event" } : true} signOut={signOut} />
        <main className="mx-auto grid w-full max-w-md px-4 py-12">
          <section className={SHEET}>
            <h1 className="text-xl font-semibold">This proposal isn&apos;t available</h1>
            <p className="text-sm text-plan-ink-2">
              Only the person who signs for this event can see the approved proposal, once the contract has been sent. If you think it should be
              available, contact your DJ.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const e = facts.home;
  const dj = e.tenantName;
  const live = await liveBrand(slug);
  return (
    <div data-plan-shell className="min-h-dvh bg-plan-canvas">
      <ClientHeader email={auth.user.email ?? null} back={{ href: hub, label: "Your event" }} signOut={signOut} />
      <main style={brandStyle(live?.brandColors.primary)} className="mx-auto grid w-full max-w-3xl gap-5 px-4 pt-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:gap-6 sm:pt-8">
        <header className="grid gap-3">
          <span className="flex min-h-8 min-w-0 items-center text-sm">
            <BrandLogo logo={live?.logo ?? null} name={dj} className="max-h-9 max-w-36" fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
          </span>
          <div className="grid gap-1.5">
            <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight text-balance sm:text-[1.75rem]">Your approved proposal</h1>
            <p className="text-sm text-plan-ink-2">
              <span className="font-medium text-foreground [overflow-wrap:anywhere]">{e.title}</span>
              {" · "}Approved by {dj} on {formatEventDate(dateIn(e.timezone, new Date(approved.approved_at)))}
            </p>
          </div>
        </header>
        <section aria-labelledby="choices-heading" className={SHEET} data-testid="approved-proposal">
          <div className="grid gap-1">
            <h2 id="choices-heading" className="text-lg leading-snug font-semibold">The package and choices you agreed</h2>
            <p className="max-w-[60ch] text-sm text-pretty text-plan-ink-2">
              These are the selections and prices in your {approved.contract.status === "signed" ? "signed contract" : "contract"} with {dj}. They don&apos;t change,
              even if {dj} updates their packages or prices later.
            </p>
          </div>
          <SelectionSummary offer={approved.proposal.offer} selection={approved.selection.priced} headingLevel={3} />
        </section>
      </main>
    </div>
  );
}
