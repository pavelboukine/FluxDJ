"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requestJoinSignIn, type JoinRequestResult } from "./actions";

/**
 * The invitation token is in the URL fragment, which browsers never send to
 * the server. It is read once and removed from the address bar. Nothing
 * happens until the DJ clicks: opening the link (or an email scanner fetching
 * it) sends no email and creates nothing.
 */
export function JoinRequest() {
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState<"loading" | "missing" | "ready">("loading");
  const [result, setResult] = useState<JoinRequestResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (token.current === null) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    setReady(token.current ? "ready" : "missing");
  }, []);

  function request() {
    const value = token.current;
    if (!value) return;
    start(async () => setResult(await requestJoinSignIn(value)));
  }

  if (ready === "loading") return <p className="text-sm text-muted-foreground">Opening your invitation…</p>;
  if (ready === "missing") {
    return <p role="alert" className="text-sm">This link is incomplete. Open the invitation from the button in your Flux DJ invitation email.</p>;
  }
  if (result?.status === "ok") {
    return (
      <div role="status" className="grid gap-2 text-sm">
        <p className="font-medium">Check your email.</p>
        <p>
          We sent a second email, &ldquo;Confirm your email to set up Flux DJ&rdquo;, to {result.maskedEmail}. Open it on any device, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. You then name your business on that device. The link works
          once and expires in one hour.
        </p>
      </div>
    );
  }
  if (result?.status === "used") {
    return (
      <p role="status" className="text-sm">
        This invitation was already used to create a workspace. <Link className="underline" href="/login">Sign in</Link> to open it.
      </p>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p>
        First, we confirm that this invitation reached you: we email a secure sign-in link to the invited address. No password is needed.
      </p>
      <div>
        <Button type="button" onClick={request} disabled={pending}>{pending ? "Sending…" : "Email me a sign-in link"}</Button>
      </div>
      {result?.status === "invalid" ? (
        <p role="alert" className="text-destructive">This invitation is no longer valid. It may have expired, been replaced by a newer email, or been cancelled. Use your most recent invitation email, or ask for a new one.</p>
      ) : null}
      {result?.status === "rate_limited" ? <p role="alert" className="text-destructive">Too many requests. Please wait a few minutes and try again.</p> : null}
      {result?.status === "error" ? <p role="alert" className="text-destructive">Something went wrong. Please try again.</p> : null}
    </div>
  );
}
