import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PublicShell } from "@/components/app/public-shell";
import { signOut } from "@/app/auth/confirm/actions";
import { allowedNext, loginHref, signInRole, type SignInRole } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Flux DJ" };

const COPY: Record<SignInRole | "any", { heading: string; text: string }> = {
  dj: {
    heading: "Sign in to Flux DJ",
    text: "Your events, proposals, contracts and client planning, in one place. Enter your email and we'll send you a sign-in link and code.",
  },
  client: {
    heading: "Access your event",
    text: "Review your event details, read and sign your contract, and plan the day with your DJ. Use the email address your DJ has for you.",
  },
  any: {
    heading: "Sign in to Flux DJ",
    text: "For DJs and their clients. Enter your email and we'll send you a sign-in link and code. No password needed.",
  },
};

/**
 * Sign-in for DJs and clients: one email link-and-code sign-in for both
 * (?role=dj or ?role=client only changes the wording; a person can be both),
 * continuing to an allow-listed page that asked for it (?next=), or to the
 * role's home. Access is never decided here: every page checks it.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, notice, role: rawRole, next: rawNext } = await searchParams;
  const role = signInRole(rawRole);
  const next = allowedNext(rawNext);
  const copy = COPY[role ?? "any"];
  // Shown when a staff page or action finds a signed-in account without any staff role.
  const signedInAs = notice === "no-staff-access" ? (await (await createClient()).auth.getUser()).data.user?.email : undefined;
  const other: SignInRole = role === "client" ? "dj" : "client";

  return (
    <PublicShell>
      <div className="flex flex-1 items-start justify-center pt-6 sm:items-center sm:pt-0">
        <section aria-labelledby="login-heading" className="grid w-full max-w-md gap-6 rounded-2xl border bg-card/95 p-6 shadow-sm backdrop-blur sm:p-8">
          <div className="grid gap-2">
            {role ? <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{role === "dj" ? "For DJs" : "For clients"}</p> : null}
            <h1 id="login-heading" className="text-2xl font-semibold tracking-tight">{copy.heading}</h1>
            <p className="text-sm text-muted-foreground">{copy.text}</p>
            {next ? <p className="text-sm text-muted-foreground" data-testid="login-next">After signing in, you&apos;ll go straight back to the page you were opening.</p> : null}
          </div>

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
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              That sign-in link is invalid or has expired. Request a new one.
            </p>
          ) : null}

          <LoginForm role={role} next={next} />

          <div className="grid gap-2 border-t pt-4 text-sm text-muted-foreground">
            {role === "dj" ? (
              <p>New to Flux DJ? DJ accounts are by invitation for now.</p>
            ) : role === "client" ? (
              <p>First time here? Your DJ&apos;s email has a link that opens your contract or planning directly.</p>
            ) : null}
            <p>
              {role === "client" ? "Are you a DJ? " : role === "dj" ? "Planning an event with your DJ? " : "Looking for something specific? "}
              <Link className="font-medium text-foreground underline underline-offset-4" href={loginHref(other, next)}>
                {other === "dj" ? "DJ sign in" : "Client sign in"}
              </Link>
            </p>
          </div>

          {process.env.NODE_ENV === "development" ? (
            <p className="text-xs text-muted-foreground">
              Local development: emails are captured at{" "}
              <a className="underline" href="http://127.0.0.1:54324" target="_blank" rel="noreferrer">
                http://127.0.0.1:54324
              </a>
              .
            </p>
          ) : null}
        </section>
      </div>
    </PublicShell>
  );
}
