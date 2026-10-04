import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeNext, safeOtpType } from "@/lib/auth/redirects";
import { confirmSignIn } from "./actions";

// The URL carries the one-time token, so no Referer may contain it:
// "strict-origin" sends at most the bare origin. Not "no-referrer": that makes
// browsers send "Origin: null" on a native form POST (before or without
// hydration), which the Server Actions CSRF check rightly rejects.
export const metadata: Metadata = { title: "Confirm sign in · Flux DJ", referrer: "strict-origin" };

export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const { token_hash: tokenHash, type, next } = await searchParams;
  const continueTo = safeNext(next);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Finish signing in</CardTitle>
          <CardDescription>
            {continueTo.includes("/invitations/")
              ? "Confirm to verify your email and continue to your contract on this device."
              : "Confirm to sign in to Flux DJ on this device."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {typeof tokenHash === "string" ? (
            <form action={confirmSignIn}>
              <input type="hidden" name="token_hash" value={tokenHash} />
              <input type="hidden" name="type" value={safeOtpType(type)} />
              <input type="hidden" name="next" value={continueTo} />
              <Button type="submit" className="w-full">
                Sign in
              </Button>
            </form>
          ) : (
            <p className="text-sm text-destructive">This link is incomplete. Request a new sign-in link.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
