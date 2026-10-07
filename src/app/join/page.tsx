import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JoinRequest } from "./join-request";
import { JoinSteps } from "./steps";

export const metadata: Metadata = { title: "Your Flux DJ invitation", robots: { index: false, follow: false }, referrer: "strict-origin" };

/** Where the invitation email lands (/join#token). Viewing it changes nothing. */
export default function JoinPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Set up your DJ business on Flux DJ</CardTitle>
          <CardDescription>You&apos;ve been invited to create your own workspace for proposals, contracts and event planning.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <JoinSteps current={1} />
          <JoinRequest />
          <noscript>
            <p className="text-sm">
              This first step needs JavaScript, because the invitation code stays in your browser. If you already have a Flux DJ sign-in, you
              can <Link className="underline" href="/login">sign in here</Link>, then open the invitation again.
            </p>
          </noscript>
        </CardContent>
      </Card>
    </main>
  );
}
