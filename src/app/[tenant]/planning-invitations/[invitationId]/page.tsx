import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClipboardList } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PublicCard } from "@/components/app/public-shell";
import { BRAND_BUTTON, TenantPublicCard } from "@/components/app/tenant-public-shell";
import { liveBrand } from "@/lib/branding/logo.server";
import { signOut } from "@/app/auth/confirm/actions";
import { UUID_RE } from "@/lib/forms";
import { formatEventDate } from "@/lib/planning/view";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";
import { acceptPlanningInvitation } from "./actions";

export const metadata: Metadata = { title: "Plan your event", robots: { index: false, follow: false }, referrer: "strict-origin" };

type Status = {
  state: "signed_out" | "invalid" | "unverified" | "wrong_account" | "ready" | "accepted";
  tenant_display_name?: string;
  event_title?: string;
  event_date?: string;
  client_name?: string;
  event_id?: string;
  signed_in_email?: string;
  intended_email?: string;
};

/** After email verification: confirm to open planning for the invited event. Viewing this page changes nothing. */
export default async function PlanningInvitationPage({ params }: PageProps<"/[tenant]/planning-invitations/[invitationId]">) {
  const { tenant: slug, invitationId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(invitationId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const status: Status = auth.user
    ? (((await supabase.rpc("client_planning_invitation_status", { p_invitation_id: invitationId, p_tenant_slug: slug })).data as Status | null) ?? { state: "invalid" })
    : { state: "signed_out" };
  const when = status.event_date ? ` (${formatEventDate(status.event_date)})` : "";
  // The business's branding (active businesses only), once the signed-in status check has tied this invitation to the
  // URL's business (it returns these states only for a usable invitation). Signed out or unusable: the neutral Flux
  // frame and a generic message, so a stale, guessed or foreign link shows nothing of any business.
  const verified = status.state === "ready" || status.state === "accepted" || status.state === "wrong_account" || status.state === "unverified";
  const live = verified ? await liveBrand(slug) : null;
  const title = status.state === "ready" || status.state === "accepted" ? "Your planning is ready" : "Open your event planning";
  const primary = live ? BRAND_BUTTON : undefined;
  const frame = (children: ReactNode) =>
    live ? <TenantPublicCard brand={live} title={title}>{children}</TenantPublicCard> : <PublicCard icon={ClipboardList} title={title}>{children}</PublicCard>;

  return frame(
    <>
      {status.state === "ready" ? (
        <>
          <p>
            Hi {status.client_name}. Your email is confirmed. Your event <strong>{status.event_title}</strong>{when} is booked. Let&apos;s plan
            the details.
          </p>
          <form action={acceptPlanningInvitation.bind(null, slug, invitationId)}>
            {primary ? <button type="submit" className={primary}>Open my planning</button> : <Button type="submit" size="lg" className="w-full">Open my planning</Button>}
          </form>
        </>
      ) : status.state === "accepted" ? (
        <>
          <p>Your planning for <strong>{status.event_title}</strong>{when} is ready.</p>
          {/* Already has access (e.g. from their contract): accepting again only records this invitation's acceptance, then opens planning. */}
          <form action={acceptPlanningInvitation.bind(null, slug, invitationId)}>
            {primary ? <button type="submit" className={primary}>Open my planning</button> : <Button type="submit" size="lg" className="w-full">Open my planning</Button>}
          </form>
        </>
      ) : status.state === "wrong_account" ? (
        <>
          <p role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 [overflow-wrap:anywhere]">
            You&apos;re signed in as {status.signed_in_email}, but this invitation was sent to {status.intended_email}. Sign out, then use the
            &ldquo;Confirm and continue&rdquo; link sent to that address.
          </p>
          <form action={signOut}><Button type="submit" variant="outline">Sign out</Button></form>
        </>
      ) : status.state === "invalid" ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">This invitation isn&apos;t available any more. It may have expired, been replaced by a newer email, or been cancelled. Use your most recent email from your DJ, or contact them.</p>
      ) : (
        <p>
          Please confirm your email first: open the &ldquo;Confirm your email to plan your event&rdquo; message, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. If that link expired, open your planning invitation email again
          to get a new one.
        </p>
      )}
    </>,
  );
}
