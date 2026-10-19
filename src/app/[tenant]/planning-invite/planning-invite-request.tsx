"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { requestPlanningSignIn, signedInPlanningInvitation, type PlanningSignInResult } from "./actions";

/**
 * The invitation token is in the URL fragment, which browsers never send to
 * the server, so it stays out of request logs. It is read once and removed
 * from the address bar. Nothing happens until the client clicks: opening the
 * link (or an email scanner fetching it) sends no email and grants nothing.
 * Someone already signed in as the invited address continues to the
 * invitation directly, without a second verification email.
 */
export function PlanningInviteRequest({ slug, brand }: { slug: string; brand: string }) {
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState<"loading" | "missing" | "ready">("loading");
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [result, setResult] = useState<PlanningSignInResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (token.current === null) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const value = token.current;
    if (!value) {
      setReady("missing");
      return;
    }
    let live = true;
    signedInPlanningInvitation(slug, value)
      .catch(() => null)
      .then((id) => {
        if (!live) return;
        setSignedIn(id);
        setReady("ready");
      });
    return () => {
      live = false;
    };
  }, [slug]);

  function request() {
    const value = token.current;
    if (!value) return;
    start(async () => setResult(await requestPlanningSignIn(slug, value)));
  }

  if (ready === "loading") return <p role="status" className="text-muted-foreground">Opening your invitation…</p>;
  if (ready === "missing") {
    return <p role="alert">This link is incomplete. Open your planning from the button in your email from {brand}.</p>;
  }
  if (signedIn) {
    return (
      <div className="grid gap-4">
        <p>You&apos;re already signed in with the email address {brand} invited, so there&apos;s nothing to confirm.</p>
        <Link className={buttonVariants({ size: "lg", className: "w-full" })} href={`/${slug}/planning-invitations/${signedIn}`}>Continue to my planning</Link>
      </div>
    );
  }
  if (result?.status === "ok") {
    return (
      <div role="status" className="grid gap-2">
        <p className="font-medium">Check your email.</p>
        <p>
          We sent a second email, &ldquo;Confirm your email to plan your event&rdquo;, to {result.maskedEmail}. Open it on any device, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. The link works once and expires in one hour.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <p>
        It&apos;s time to plan your event. To keep your planning private, we first confirm your email address: we will email a secure
        sign-in link to the address {brand} has on file. No password is needed.
      </p>
      <Button type="button" size="lg" className="w-full" onClick={request} disabled={pending}>{pending ? "Sending…" : "Email me a sign-in link"}</Button>
      {result?.status === "invalid" ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">This invitation is no longer valid. It may have expired or been replaced. Use your most recent email from {brand}, or contact them.</p>
      ) : null}
      {result?.status === "rate_limited" ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">Too many requests. Please wait a few minutes and try again.</p> : null}
      {result?.status === "error" ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">Something went wrong. Please try again.</p> : null}
    </div>
  );
}
