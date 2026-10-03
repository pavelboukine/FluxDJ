import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmSignIn } from "./actions";

export const metadata: Metadata = { title: "Confirm sign in · Flux DJ", referrer: "no-referrer" };

export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const { token_hash: tokenHash } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Finish signing in</CardTitle>
          <CardDescription>Confirm to sign in to Flux DJ on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          {typeof tokenHash === "string" ? (
            <form action={confirmSignIn}>
              <input type="hidden" name="token_hash" value={tokenHash} />
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
