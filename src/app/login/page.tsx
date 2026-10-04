import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/auth/confirm/actions";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Flux DJ" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, notice } = await searchParams;
  // Shown when a staff page or action finds a signed-in account without any staff role.
  const signedInAs = notice === "no-staff-access" ? (await (await createClient()).auth.getUser()).data.user?.email : undefined;
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>For DJs and their clients. No password: we email you a one-time sign-in link. First time reading a contract? Use the link in your contract email instead.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {signedInAs ? (
            <div role="alert" className="grid gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p>
                You&apos;re signed in as {signedInAs}, which has no staff access, so nothing was changed. This usually happens after opening a
                client sign-in link in this browser: a browser holds one Flux DJ sign-in at a time. Sign in below with your staff email (that
                replaces the other sign-in), or sign out.
              </p>
              <form action={signOut}><Button type="submit" size="sm" variant="outline">Sign out</Button></form>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              That sign-in link is invalid or has expired. Request a new one.
            </p>
          ) : null}
          <LoginForm />
          {process.env.NODE_ENV === "development" ? (
            <p className="text-xs text-muted-foreground">
              Local development: emails are captured at{" "}
              <a className="underline" href="http://127.0.0.1:54324" target="_blank" rel="noreferrer">
                http://127.0.0.1:54324
              </a>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
