import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { signOut } from "@/app/auth/confirm/actions";
import { loginHref } from "@/lib/auth/redirects";
import { UUID_RE } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { InviteCard } from "../invite-card";
import { acceptTeamInvitation } from "./actions";

export const metadata: Metadata = { title: "Join your team · Flux DJ", robots: { index: false, follow: false }, referrer: "strict-origin" };

type Status = {
  state: "signed_out" | "invalid" | "unverified" | "wrong_account" | "unavailable" | "ready" | "accepted";
  email?: string;
  display_name?: string;
  expires_at?: string;
  already_member?: boolean;
  signed_in_email?: string;
  intended_email?: string;
  slug?: string;
  active?: boolean;
};

const fmt = (iso?: string) =>
  iso ? new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short", timeZone: "America/Toronto" }).format(new Date(iso)) : "";

/**
 * After email verification: accept the staff invitation. The business is named
 * only to the verified invited address. Viewing this page changes nothing;
 * only the Accept POST grants access.
 */
export default async function TeamInvitation({ params }: PageProps<"/join/team/[invitationId]">) {
  const { invitationId } = await params;
  if (!UUID_RE.test(invitationId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const status: Status = auth.user
    ? (((await supabase.rpc("staff_invitation_status", { p_invitation_id: invitationId })).data as Status | null) ?? { state: "invalid" })
    : { state: "signed_out" };

  if (status.state === "ready") {
    return (
      <InviteCard title={`Join ${status.display_name} on Flux DJ`} description={`Your email ${status.email} is confirmed.`}>
        <p>
          As <strong>staff</strong>, you can work with {status.display_name}&apos;s events, clients, proposals, contracts and event planning,
          and with their catalog and templates. The owner keeps control of business settings, branding, taxes and the team, and can remove
          your access at any time.
        </p>
        {status.already_member ? <p role="status" className="text-muted-foreground">You already have access to this business. Accepting keeps your current role.</p> : null}
        <p className="text-muted-foreground">Your other Flux DJ businesses and any events you have as a client are unchanged. This invitation expires on {fmt(status.expires_at)}.</p>
        <ActionForm action={acceptTeamInvitation.bind(null, invitationId)} submitLabel="Accept invitation" pendingLabel="Accepting…">
          {null}
        </ActionForm>
      </InviteCard>
    );
  }
  if (status.state === "accepted") {
    return (
      <InviteCard title={status.active ? `You've joined ${status.display_name}` : "This invitation was accepted"}>
        {status.active ? (
          <>
            <p role="status">You now have staff access to {status.display_name} on Flux DJ.</p>
            <div>
              <Link className={buttonVariants({ size: "lg" })} href={`/staff/${status.slug}`}>Open business dashboard</Link>
            </div>
          </>
        ) : (
          <p role="status">Your access to this business has ended or is unavailable right now. Contact the business if you think this is a mistake.</p>
        )}
      </InviteCard>
    );
  }
  if (status.state === "wrong_account") {
    return (
      <InviteCard title="This invitation is for another email">
        <p role="alert" className="[overflow-wrap:anywhere]">
          You&apos;re signed in as {status.signed_in_email}, but this invitation was sent to {status.intended_email}. Sign out, then use the
          &ldquo;Confirm and continue&rdquo; link sent to that address.
        </p>
        <form action={signOut}><Button type="submit" variant="outline">Sign out</Button></form>
      </InviteCard>
    );
  }
  if (status.state === "unavailable") {
    return (
      <InviteCard title="This workspace is unavailable">
        <p role="alert">This business&apos;s Flux DJ workspace is unavailable right now, so the invitation can&apos;t be accepted. Try again later.</p>
      </InviteCard>
    );
  }
  if (status.state === "invalid") {
    return (
      <InviteCard title="This invitation isn't available">
        <p role="alert">
          It may have expired, been replaced by a newer email, been cancelled or already been used. Use your most recent invitation email, or
          ask the business for a new one.
        </p>
      </InviteCard>
    );
  }
  return (
    <InviteCard title="Confirm your email first">
      <p>
        Open the &ldquo;Confirm your email to join…&rdquo; message, click <strong>Confirm and continue</strong>, then <strong>Sign in</strong>.
        If that link expired, open your invitation email again to get a new one.
      </p>
      {status.state === "signed_out" ? (
        <p className="text-muted-foreground">
          Already use Flux DJ with the invited address?{" "}
          <Link className="font-medium text-foreground underline" href={loginHref("dj", `/join/team/${invitationId}`)}>Sign in</Link> and you&apos;ll
          come back here.
        </p>
      ) : null}
    </InviteCard>
  );
}
