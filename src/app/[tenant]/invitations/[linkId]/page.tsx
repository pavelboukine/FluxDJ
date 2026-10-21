import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileSignature } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PublicCard } from "@/components/app/public-shell";
import { BRAND_BUTTON, TenantPublicCard } from "@/components/app/tenant-public-shell";
import { liveBrand } from "@/lib/branding/logo.server";
import { signOut } from "@/app/auth/confirm/actions";
import { UUID_RE } from "@/lib/forms";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";
import { acceptInvitation } from "./actions";

export const metadata: Metadata = { title: "Open your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

type Status = {
  state: "signed_out" | "invalid" | "unverified" | "wrong_account" | "ready" | "accepted";
  tenant_display_name?: string;
  event_title?: string;
  signer_name?: string;
  contract_id?: string;
  signed_in_email?: string;
  intended_email?: string;
};

/** After email verification: confirm to open the contract. Viewing this page changes nothing. */
export default async function InvitationPage({ params }: PageProps<"/[tenant]/invitations/[linkId]">) {
  const { tenant: slug, linkId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(linkId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const status: Status = auth.user
    ? (((await supabase.rpc("client_invitation_status", { p_link_id: linkId, p_tenant_slug: slug })).data as Status | null) ?? { state: "invalid" })
    : { state: "signed_out" };
  // The business's branding (active businesses only), once the signed-in status check has tied this invitation to the
  // URL's business (it returns these states only for a usable invitation). Signed out or unusable: the neutral Flux
  // frame and a generic message, so a stale, guessed or foreign link shows nothing of any business.
  const verified = status.state === "ready" || status.state === "accepted" || status.state === "wrong_account" || status.state === "unverified";
  const live = verified ? await liveBrand(slug) : null;
  const title = status.state === "ready" || status.state === "accepted" ? "Your agreement is ready" : "Open your contract";
  const frame = (children: ReactNode) =>
    live ? (
      <TenantPublicCard brand={live} title={title} description={status.state === "ready" || status.state === "accepted" ? <>Please review and sign your agreement with {live.displayName}.</> : undefined}>
        {children}
      </TenantPublicCard>
    ) : (
      <PublicCard icon={FileSignature} title={title}>{children}</PublicCard>
    );
  const primary = live ? BRAND_BUTTON : buttonVariants({ size: "lg", className: "w-full" });

  return frame(
    <>
      {status.state === "ready" ? (
        <>
          <p>Hi {status.signer_name}. Your email is confirmed. Your contract for <strong>{status.event_title}</strong> is ready to read.</p>
          <form action={acceptInvitation.bind(null, slug, linkId)}>
            <button type="submit" className={primary}>Open my contract</button>
          </form>
        </>
      ) : status.state === "accepted" ? (
        <>
          <p>Your contract for <strong>{status.event_title}</strong> is ready to read.</p>
          <Link className={primary} href={`/${slug}/contracts/${status.contract_id}`}>Open my contract</Link>
        </>
      ) : status.state === "wrong_account" ? (
        <>
          <p role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 [overflow-wrap:anywhere]">
            You&apos;re signed in as {status.signed_in_email}, but this contract was sent to {status.intended_email}. Sign out, then use the
            &ldquo;Confirm and continue&rdquo; link sent to that address.
          </p>
          <form action={signOut}><Button type="submit" variant="outline">Sign out</Button></form>
        </>
      ) : status.state === "invalid" ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">This invitation isn&apos;t available any more. It may have expired, been replaced by a newer email, or been cancelled. Use your most recent email from your DJ, or contact them.</p>
      ) : (
        <p>
          Please confirm your email first: open the &ldquo;Confirm your email to read your contract&rdquo; message, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. If that link expired, open your contract email again to get a new one.
        </p>
      )}
    </>,
  );
}
