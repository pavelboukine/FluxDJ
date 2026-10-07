import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signOut } from "@/app/auth/confirm/actions";
import { publicEnv } from "@/lib/env";
import { UUID_RE } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { JoinSteps } from "../steps";
import { createWorkspace } from "./actions";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Set up your DJ business · Flux DJ", robots: { index: false, follow: false }, referrer: "strict-origin" };

type Status = {
  state: "signed_out" | "invalid" | "unverified" | "wrong_account" | "ready" | "created";
  email?: string;
  signed_in_email?: string;
  intended_email?: string;
  slug?: string;
  display_name?: string;
};

/**
 * After email verification: name the business and choose its address.
 * Viewing this page changes nothing; only the form's POST creates the workspace.
 */
export default async function JoinInvitation({ params }: PageProps<"/join/[invitationId]">) {
  const { invitationId } = await params;
  if (!UUID_RE.test(invitationId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const status: Status = auth.user
    ? (((await supabase.rpc("platform_invitation_status", { p_invitation_id: invitationId })).data as Status | null) ?? { state: "invalid" })
    : { state: "signed_out" };
  const host = new URL(publicEnv().NEXT_PUBLIC_APP_URL).host;
  const step = status.state === "ready" ? 3 : status.state === "created" ? 4 : 2;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>{status.state === "created" ? "Your workspace is ready" : "Set up your DJ business"}</CardTitle>
          {status.state === "ready" ? <CardDescription>Your email {status.email} is confirmed.</CardDescription> : null}
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          {status.state !== "invalid" ? <JoinSteps current={step} /> : null}
          {status.state === "ready" ? (
            <WorkspaceForm action={createWorkspace.bind(null, invitationId)} host={host} />
          ) : status.state === "created" ? (
            <>
              <p><strong>{status.display_name}</strong> is set up at {host}/{status.slug}.</p>
              <Link className="underline" href={`/staff/${status.slug}?welcome=1`}>Open your workspace</Link>
            </>
          ) : status.state === "wrong_account" ? (
            <>
              <p role="alert">
                You&apos;re signed in as {status.signed_in_email}, but this invitation was sent to {status.intended_email}. Sign out, then use the
                &ldquo;Confirm and continue&rdquo; link sent to that address.
              </p>
              <form action={signOut}><Button type="submit" variant="outline">Sign out</Button></form>
            </>
          ) : status.state === "invalid" ? (
            <p role="alert">
              This invitation isn&apos;t available any more. It may have expired, been replaced by a newer email, or been cancelled. Use your
              most recent invitation email, or ask for a new one.
            </p>
          ) : (
            <p>
              Please confirm your email first: open the &ldquo;Confirm your email to set up Flux DJ&rdquo; message, click{" "}
              <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. If that link expired, open your invitation email again to
              get a new one.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
