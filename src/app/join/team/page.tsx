import type { Metadata } from "next";
import Link from "next/link";
import { InviteCard } from "./invite-card";
import { TeamInviteRequest } from "./team-invite-request";

export const metadata: Metadata = { title: "Your team invitation · Flux DJ", robots: { index: false, follow: false }, referrer: "strict-origin" };

/** Where the staff invitation email lands (/join/team#token). Viewing it changes nothing. */
export default function TeamInvitePage() {
  return (
    <InviteCard
      title="You're invited to join a team on Flux DJ"
      description="A DJ business has invited you to work with them in their Flux DJ workspace: their events, clients and planning tools."
    >
      <TeamInviteRequest />
      <noscript>
        <p>
          This step needs JavaScript, because the invitation code stays in your browser. If you already have a Flux DJ sign-in, you can{" "}
          <Link className="underline" href="/login">sign in here</Link>, then open the invitation again.
        </p>
      </noscript>
    </InviteCard>
  );
}
