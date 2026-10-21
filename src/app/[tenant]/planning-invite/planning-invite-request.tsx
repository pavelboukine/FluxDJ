"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ClipboardList } from "lucide-react";
import { PublicCard } from "@/components/app/public-shell";
import { BRAND_BUTTON, TenantPublicCard } from "@/components/app/tenant-public-shell";
import { openPlanningInvitation, requestPlanningSignIn, type PlanningInvitationOpen, type PlanningSignInResult } from "./actions";

/**
 * The invitation token is in the URL fragment, which browsers never send to
 * the server, so it stays out of request logs. It is read once and removed
 * from the address bar. Nothing happens until the client clicks: opening the
 * link (or an email scanner fetching it) sends no email and grants nothing.
 * The business's branding appears only once the server has matched the token
 * to a live invitation of this business (openPlanningInvitation); any other
 * link keeps the neutral Flux page and a generic message. Someone already
 * signed in as the invited address continues to the invitation directly,
 * without a second verification email.
 */
export function PlanningInviteRequest({ slug, noscript }: { slug: string; noscript?: ReactNode }) {
  const token = useRef<string | null>(null);
  const [opened, setOpened] = useState<"loading" | "missing" | PlanningInvitationOpen>("loading");
  const [result, setResult] = useState<PlanningSignInResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (token.current === null) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const value = token.current;
    if (!value) {
      setOpened("missing");
      return;
    }
    let live = true;
    openPlanningInvitation(slug, value)
      .catch(() => ({ brand: null, signedIn: null }))
      .then((open) => {
        if (live) setOpened(open);
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

  if (opened === "loading") {
    // Neutral until the link is checked: no business is named before then.
    return (
      <div data-plan-shell className="flex min-h-dvh flex-col items-center justify-center bg-plan-canvas px-4">
        <p role="status" className="text-sm text-plan-ink-2">Opening your invitation…</p>
        {noscript}
      </div>
    );
  }
  if (opened === "missing" || !opened.brand) {
    return (
      <PublicCard icon={ClipboardList} title="Open your event planning">
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">
          {opened === "missing"
            ? "This link is incomplete. Open your planning from the button in your invitation email."
            : "This invitation isn't available any more. It may have expired, been replaced by a newer email, or been cancelled. Use your most recent email from your DJ, or contact them."}
        </p>
      </PublicCard>
    );
  }

  const brand = opened.brand.displayName;
  return (
    <TenantPublicCard
      brand={opened.brand}
      title="You're invited to plan your event"
      description="Let's get everything ready for your event: the timing, the music and the moments that matter to you."
    >
      {opened.signedIn ? (
        <div className="grid gap-4">
          <p>You&apos;re already signed in with the email address {brand} invited, so there&apos;s nothing to confirm.</p>
          <Link className={BRAND_BUTTON} href={`/${slug}/planning-invitations/${opened.signedIn}`}>Continue to my planning</Link>
        </div>
      ) : result?.status === "ok" ? (
        <div role="status" className="grid gap-2">
          <p className="font-medium">Check your email.</p>
          <p>
            We sent a second email, &ldquo;Confirm your email to plan your event&rdquo;, to {result.maskedEmail}. Open it on any device, click{" "}
            <strong>Confirm and continue</strong>, then <strong>Sign in</strong>. The link works once and expires in one hour.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          <p>
            To keep your planning private, we first confirm your email address: we&apos;ll email a secure sign-in link to the address {brand}{" "}
            has on file. No password is needed.
          </p>
          <button type="button" className={BRAND_BUTTON} onClick={request} disabled={pending}>{pending ? "Sending…" : "Email me a sign-in link"}</button>
          {result?.status === "invalid" ? (
            <p role="alert" className="rounded-lg bg-destructive/5 p-3 font-medium text-destructive">This invitation is no longer valid. It may have expired or been replaced. Use your most recent email from {brand}, or contact them.</p>
          ) : null}
          {result?.status === "rate_limited" ? <p role="alert" className="rounded-lg bg-destructive/5 p-3 font-medium text-destructive">Too many requests. Please wait a few minutes and try again.</p> : null}
          {result?.status === "error" ? <p role="alert" className="rounded-lg bg-destructive/5 p-3 font-medium text-destructive">Something went wrong. Please try again.</p> : null}
        </div>
      )}
    </TenantPublicCard>
  );
}
