"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { continueTeamInvitation, type TeamInviteResult } from "./actions";

/**
 * The invitation token is in the URL fragment, which browsers never send to
 * the server. It is read once and removed from the address bar. Nothing
 * happens until the person clicks: opening the link (or an email scanner
 * fetching it) sends no email and grants nothing.
 */
export function TeamInviteRequest() {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState<"loading" | "missing" | "ready">("loading");
  const [result, setResult] = useState<TeamInviteResult | null>(null);
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
    start(async () => {
      const outcome = await continueTeamInvitation(value);
      if (outcome.status === "signed_in") router.push(`/join/team/${outcome.invitationId}`);
      else setResult(outcome);
    });
  }

  if (ready === "loading") return <p className="text-muted-foreground">Opening your invitation…</p>;
  if (ready === "missing") {
    return <p role="alert">This link is incomplete. Open the invitation from the button in your Flux DJ invitation email.</p>;
  }
  if (result?.status === "ok") {
    return (
      <div role="status" className="grid gap-2">
        <p className="font-medium">Check your email.</p>
        <p>
          We sent a second email, &ldquo;Confirm your email to join…&rdquo;, to {result.maskedEmail}. Open it on any device, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. You then accept the invitation on that device. The link works
          once and expires in one hour.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <p>
        First, we confirm that this invitation reached you: we email a secure sign-in link to the invited address. No password is needed. If
        you already use Flux DJ with that address, it signs you in to your existing account.
      </p>
      <div>
        <Button type="button" size="lg" onClick={request} disabled={pending}>{pending ? "Continuing…" : "Continue"}</Button>
      </div>
      {result?.status === "invalid" ? (
        <p role="alert" className="text-destructive">
          This invitation is no longer valid. It may have expired, been replaced by a newer email, been cancelled or already been used. Ask
          the business for a new invitation.
        </p>
      ) : null}
      {result?.status === "rate_limited" ? <p role="alert" className="text-destructive">Too many requests. Please wait a few minutes and try again.</p> : null}
      {result?.status === "error" ? <p role="alert" className="text-destructive">Something went wrong. Please try again.</p> : null}
    </div>
  );
}
