"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { requestContractSignIn, type SignInRequestResult } from "./actions";

/**
 * The invitation token is in the URL fragment, which browsers never send to
 * the server, so it stays out of request logs. It is read once and removed
 * from the address bar. Nothing happens until the client clicks: opening the
 * link (or an email scanner fetching it) sends no email and grants nothing.
 */
export function InviteRequest({ slug, brand }: { slug: string; brand: string }) {
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState<"loading" | "missing" | "ready">("loading");
  const [result, setResult] = useState<SignInRequestResult | null>(null);
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
    start(async () => setResult(await requestContractSignIn(slug, value)));
  }

  if (ready === "loading") return <p className="text-sm text-muted-foreground">Opening your invitation…</p>;
  if (ready === "missing") {
    return <p role="alert" className="text-sm">This link is incomplete. Open your contract from the button in your email from {brand}.</p>;
  }
  if (result?.status === "ok") {
    return (
      <div role="status" className="grid gap-2 text-sm">
        <p className="font-medium">Check your email.</p>
        <p>
          We sent a second email, &ldquo;Confirm your email to read your contract&rdquo;, to {result.maskedEmail}. Open it on any device, click{" "}
          <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. The link works once and expires in one hour.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p>
        To keep your contract private, we first confirm your email address. We will email a secure sign-in link to the address {brand} has
        on file. No password is needed.
      </p>
      <div>
        <Button type="button" onClick={request} disabled={pending}>{pending ? "Sending…" : "Email me a sign-in link"}</Button>
      </div>
      {result?.status === "invalid" ? (
        <p role="alert" className="text-destructive">This invitation is no longer valid. It may have expired or been replaced. Use your most recent email from {brand}, or contact them.</p>
      ) : null}
      {result?.status === "rate_limited" ? <p role="alert" className="text-destructive">Too many requests. Please wait a few minutes and try again.</p> : null}
      {result?.status === "error" ? <p role="alert" className="text-destructive">Something went wrong. Please try again.</p> : null}
    </div>
  );
}
