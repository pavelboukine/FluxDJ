import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const brand = status.tenant_display_name ?? "your DJ";

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader><CardTitle>{status.state === "ready" || status.state === "accepted" ? `Your contract from ${brand}` : "Open your contract"}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {status.state === "ready" ? (
            <>
              <p>Hi {status.signer_name}. Your email is confirmed. Your contract for <strong>{status.event_title}</strong> is ready to read.</p>
              <form action={acceptInvitation.bind(null, slug, linkId)}>
                <Button type="submit">Open my contract</Button>
              </form>
            </>
          ) : status.state === "accepted" ? (
            <>
              <p>Your contract for <strong>{status.event_title}</strong> is ready to read.</p>
              <Link className="underline" href={`/${slug}/contracts/${status.contract_id}`}>Open my contract</Link>
            </>
          ) : status.state === "wrong_account" ? (
            <>
              <p role="alert">
                You&apos;re signed in as {status.signed_in_email}, but this contract was sent to {status.intended_email}. Sign out, then use the
                &ldquo;Confirm and continue&rdquo; link sent to that address.
              </p>
              <form action={signOut}><Button type="submit" variant="outline">Sign out</Button></form>
            </>
          ) : status.state === "invalid" ? (
            <p role="alert">This invitation isn&apos;t available any more. It may have expired, been replaced by a newer email, or been cancelled. Use your most recent email from your DJ, or contact them.</p>
          ) : (
            <p>
              Please confirm your email first: open the &ldquo;Confirm your email to read your contract&rdquo; message, click{" "}
              <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. If that link expired, open your contract email again to get a new one.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
