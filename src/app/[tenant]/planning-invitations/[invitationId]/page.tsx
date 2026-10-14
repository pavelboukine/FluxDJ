import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PublicCard } from "@/components/app/public-shell";
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

/** After email verification: confirm to open planning for an event booked elsewhere. Viewing this page changes nothing. */
export default async function PlanningInvitationPage({ params }: PageProps<"/[tenant]/planning-invitations/[invitationId]">) {
  const { tenant: slug, invitationId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(invitationId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const status: Status = auth.user
    ? (((await supabase.rpc("client_planning_invitation_status", { p_invitation_id: invitationId, p_tenant_slug: slug })).data as Status | null) ?? { state: "invalid" })
    : { state: "signed_out" };
  const brand = status.tenant_display_name ?? "your DJ";
  const when = status.event_date ? ` (${formatEventDate(status.event_date)})` : "";

  return (
    <PublicCard icon={ClipboardList} title={status.state === "ready" || status.state === "accepted" ? `Plan your event with ${brand}` : "Open your event planning"}>
      {status.state === "ready" ? (
        <>
          <p>
            Hi {status.client_name}. Your email is confirmed. Your event <strong>{status.event_title}</strong>{when} is booked. Let&apos;s plan
            the details.
          </p>
          <form action={acceptPlanningInvitation.bind(null, slug, invitationId)}>
            <Button type="submit" size="lg" className="w-full">Open my planning</Button>
          </form>
        </>
      ) : status.state === "accepted" ? (
        <>
          <p>Your planning for <strong>{status.event_title}</strong>{when} is ready.</p>
          <Link className={buttonVariants({ size: "lg", className: "w-full" })} href={`/${slug}/planning/${status.event_id}`}>Open my planning</Link>
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
    </PublicCard>
  );
}
