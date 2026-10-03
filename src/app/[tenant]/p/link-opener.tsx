"use client";

import { useEffect, useRef, useState } from "react";

type State = "opening" | "missing" | "invalid" | "superseded" | "rate_limited" | "error";
type ExchangeResult = { status: Exclude<State, "opening" | "missing"> | "ok"; redirect?: string };

const MESSAGES: Record<Exclude<State, "opening">, string> = {
  missing: "This link is incomplete. Open the proposal from the button in your email.",
  invalid: "This proposal link is not valid or has expired. Please use the link in your most recent email, or contact your DJ.",
  superseded: "A newer version of this proposal has been sent. Please open the link in your most recent email.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  error: "Something went wrong opening your proposal. Please try again.",
};

// One exchange per token per page load, even if the effect runs twice
// (React Strict Mode) or the component remounts.
let pendingExchange: { token: string; promise: Promise<ExchangeResult> } | null = null;

function exchangeOnce(slug: string, token: string): Promise<ExchangeResult> {
  if (pendingExchange?.token === token) return pendingExchange.promise;
  const promise = (async (): Promise<ExchangeResult> => {
    try {
      const response = await fetch(`/${slug}/p/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const body = (await response.json().catch(() => ({}))) as { status?: string; redirect?: string };
      if (body.status === "ok" && body.redirect) return { status: "ok", redirect: body.redirect };
      if (body.status === "superseded" || body.status === "rate_limited") return { status: body.status };
      return { status: response.status === 404 ? "invalid" : "error" };
    } catch {
      return { status: "error" };
    }
  })();
  pendingExchange = { token, promise };
  return promise;
}

/**
 * The token lives in the URL fragment (#...), which browsers never send to the
 * server, so it cannot appear in request logs or analytics, and email
 * scanners that do not run JavaScript cannot open sessions. It is read once,
 * removed from the address bar immediately, and exchanged by POST for a
 * session cookie.
 */
export function LinkOpener({ slug }: { slug: string }) {
  const [state, setState] = useState<State>("opening");
  const token = useRef<string | null>(null);

  useEffect(() => {
    if (token.current === null) {
      token.current = window.location.hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const value = token.current;
    let cancelled = false;
    (async () => {
      if (!value) {
        setState("missing");
        return;
      }
      const result = await exchangeOnce(slug, value);
      if (cancelled) return;
      if (result.status === "ok" && result.redirect?.startsWith(`/${slug}/proposals/`)) {
        window.location.replace(result.redirect);
        return;
      }
      setState(result.status === "ok" ? "error" : result.status);
    })();
    // Opening another link in this same tab only changes the fragment, which
    // does not reload the page: reload so the new token is exchanged.
    const onHashChange = () => {
      if (window.location.hash.length > 1) window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [slug]);

  return (
    <p role={state === "opening" ? "status" : "alert"} className="text-sm">
      {state === "opening" ? "Opening your proposal…" : MESSAGES[state]}
    </p>
  );
}
