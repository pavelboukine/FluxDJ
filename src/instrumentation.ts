import type { Instrumentation } from "next";
import { errorCode, logEvent } from "@/lib/observability";

/** Navigation signals (redirect, notFound, …) that Next.js throws on purpose; never errors. */
const NAVIGATION = /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

/** The visitor left before the response finished (closed the tab, navigated away): not an application error. */
function clientAborted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "AbortError" || code === "ECONNRESET" || code === "ABORT_ERR" || /^The destination stream closed early\.?$/.test(error.message);
}

/**
 * React can report one failure from more than one render phase, with the same
 * digest: it's logged once per server instance within a minute. Bounded, so it
 * can't grow without limit.
 */
const recent = new Map<string, number>();
function seenRecently(digest: string, now = Date.now()): boolean {
  if (!digest) return false;
  for (const [key, at] of recent) if (now - at > 60_000) recent.delete(key);
  if (recent.has(digest)) return true;
  if (recent.size >= 200) recent.delete(recent.keys().next().value!);
  recent.set(digest, now);
  return false;
}

/**
 * Unexpected server errors (pages, route handlers, server actions, proxy),
 * as one structured log line each. Expected outcomes never get here: actions
 * return validation and permission results instead of throwing, and Next.js
 * handles redirects and not-found itself.
 *
 * Logged: the route pattern (e.g. /staff/[tenant]/emails, never the request
 * path, which can carry ids or tokens), the method, the kind of route, the
 * error's digest or code, and its class name. Never its message (an
 * unexpected error can quote a name or a database value that no redaction
 * reliably removes), headers, cookies, query strings or bodies. The digest
 * matches the error page the visitor saw and Next.js's own error log line.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  if (NAVIGATION.test(digest) || clientAborted(error) || seenRecently(digest)) return;
  logEvent({
    level: "error",
    category: "request",
    operation: `${request.method} ${context.routePath} (${context.routeType})`,
    code: errorCode(error),
    detail: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "non-error value thrown",
  });
};
