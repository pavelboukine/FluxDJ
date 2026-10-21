import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { ShieldCheck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PublicShell } from "@/components/app/public-shell";
import { allowedNext, nextFromRedirectTo, safeNext, safeOtpType } from "@/lib/auth/redirects";
import { SIGN_IN_NEXT_COOKIE } from "@/lib/auth/sign-in-next";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { confirmSignIn } from "./actions";

// The URL carries the one-time token, so no Referer may contain it:
// "strict-origin" sends at most the bare origin. Not "no-referrer": that makes
// browsers send "Origin: null" on a native form POST (before or without
// hydration), which the Server Actions CSRF check rightly rejects.
export const metadata: Metadata = { title: "Confirm sign in · Flux DJ", referrer: "strict-origin" };

/** What the page says, by where the sign-in continues. Nothing here is authorization: the destination checks access. */
function wording(to: string): { heading: string; text: string } {
  if (to.startsWith("/join/team/")) return { heading: "Join your team on Flux DJ", text: "Confirm to verify your email and continue to your team invitation on this device." };
  if (to.startsWith("/join/")) return { heading: "Continue setting up Flux DJ", text: "Confirm to verify your email and continue setting up your DJ business on this device." };
  if (to.includes("/invitations/")) return { heading: "Open your contract", text: "Confirm to verify your email and continue to your contract on this device." };
  if (/^\/[^/]+\/contracts\//.test(to)) return { heading: "Open your contract", text: "You're almost there. Confirm to sign in on this device and continue to your contract." };
  if (/^\/[^/]+\/events\//.test(to)) return { heading: "Open your event", text: "You're almost there. Confirm to sign in on this device and continue to your event." };
  if (/^\/[^/]+\/planning-invitations\//.test(to)) return { heading: "Open your event planning", text: "You're almost there. Confirm to verify your email and continue to your event planning on this device." };
  if (/^\/[^/]+\/planning\//.test(to)) return { heading: "Open your event planning", text: "You're almost there. Confirm to sign in on this device and continue to your planning." };
  if (to === "/my") return { heading: "Open your events", text: "You're almost there. Confirm to sign in on this device and see your events." };
  return { heading: "Welcome back to Flux DJ", text: "You're almost there. Confirm to sign in to Flux DJ on this device." };
}

/**
 * The step after "Continue to sign in" in a sign-in or invitation email: one
 * explicit button, so link scanners that only open the URL never use the
 * one-time token (confirmSignIn verifies it on POST). Where it continues, in
 * order: the link's own destination (invitations), the one the email carried
 * (redirect_to, from the sign-in form), the one this browser remembered, or
 * /staff (which sends clients to /my). Every candidate is allow-listed.
 */
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const { token_hash: tokenHash, type, next, redirect_to: redirectTo } = await searchParams;
  const carried = next === undefined ? nextFromRedirectTo(redirectTo, publicEnv().NEXT_PUBLIC_APP_URL) : null;
  const remembered = next === undefined && !carried ? allowedNext((await cookies()).get(SIGN_IN_NEXT_COOKIE)?.value) : null;
  const continueTo = safeNext(next ?? carried ?? remembered);
  const copy = wording(continueTo);
  const signedInAs = typeof tokenHash === "string" ? (await (await createClient()).auth.getUser()).data.user?.email : undefined;

  return (
    <PublicShell>
      <div className="flex flex-1 items-start justify-center pt-6 sm:items-center sm:pt-0">
        <section aria-labelledby="confirm-heading" className="grid w-full max-w-md gap-6 rounded-2xl border bg-card/95 p-6 shadow-sm backdrop-blur sm:p-8">
          {typeof tokenHash === "string" ? (
            <>
              <div className="grid gap-3">
                <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <ShieldCheck className="size-5" />
                </span>
                <h1 id="confirm-heading" className="text-2xl font-semibold tracking-tight">{copy.heading}</h1>
                <p className="text-sm text-muted-foreground">{copy.text}</p>
              </div>
              {signedInAs ? (
                <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]" data-testid="confirm-signed-in">
                  This browser is signed in as {signedInAs}. Confirming signs it in with the address this link was sent to instead.
                </p>
              ) : null}
              <form action={confirmSignIn}>
                <input type="hidden" name="token_hash" value={tokenHash} />
                <input type="hidden" name="type" value={safeOtpType(type)} />
                <input type="hidden" name="next" value={continueTo} />
                <Button type="submit" size="lg" className="w-full">
                  Sign in
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">The link works once and expires an hour after it was sent. If it has expired, you can request a new one.</p>
            </>
          ) : (
            <div className="grid gap-3">
              <h1 id="confirm-heading" className="text-2xl font-semibold tracking-tight">This link is incomplete</h1>
              <p role="alert" className="text-sm text-destructive">Part of the sign-in link is missing, so it can&apos;t be used. Request a new one.</p>
              <div>
                <Link className={buttonVariants({ size: "lg" })} href="/login">Back to sign in</Link>
              </div>
            </div>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
