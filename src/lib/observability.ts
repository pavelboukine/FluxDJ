/**
 * Structured operational logging: one JSON line per event on stderr, which
 * Vercel keeps in the function logs (and a log drain or monitoring provider
 * can read). Only for failures someone may need to act on. Expected outcomes
 * (validation, refused access, retried emails) are never logged here; each
 * email and PDF keeps its own state in the database.
 *
 * Never pass request bodies, headers, database rows or whole error objects.
 * The fields are fixed, and free text (`detail`) is redacted: email
 * addresses, URLs (links carry tokens), long token-like strings, credentials
 * and digit runs (codes) are removed.
 */
export type LogLevel = "error" | "warn";

export type LogCategory =
  /** An unexpected error in a page, route handler, server action or proxy (instrumentation.ts). */
  | "request"
  /** The scheduled email and PDF worker as a whole. */
  | "worker"
  /** Email work outside the worker's own error reporting. */
  | "email"
  /** Signed-PDF work outside the worker's own error reporting. */
  | "pdf"
  /** The monitoring itself (heartbeat, worker health record). */
  | "monitoring";

export type LogEvent = {
  level: LogLevel;
  category: LogCategory;
  /** What was being done, e.g. "scheduled run", "POST /staff/[tenant]/emails". */
  operation: string;
  /** A safe code: a database error code, an HTTP status, an error class name or a Next.js digest. */
  code?: string;
  /** A safe identifier: an outbox row, a PDF job or a contract id. */
  id?: string;
  /** Free text, redacted before it is written. */
  detail?: string;
};

const REDACTIONS: [RegExp, string][] = [
  [/\bBearer\s+\S+/gi, "Bearer [redacted]"],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)]+/g, "[url]"],
  [/[^\s"'<>@(),;:]+@[^\s"'<>@(),;:]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g, "[jwt]"],
  [/\b(?:sb|re|whsec|sk|pk)_[A-Za-z0-9_-]{8,}/g, "[key]"],
  // Token-like strings (base64url, hex), but not UUIDs: row and job ids are safe and useful.
  [/\b(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/gi, "[token]"],
  // Codes and other long numbers, but not the digits inside a UUID or an identifier.
  [/(?<![\w-])\d{6,}(?![\w-])/g, "[number]"],
];

/** Free text with addresses, links, tokens, credentials and codes removed, and capped in length. */
export function redact(text: string, max = 500): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// Real codes are short (SQLSTATE, PGRST…, ECONNRESET, a digest, a class name); longer strings could be tokens.
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,32}$/;

/** A short, safe code for an error: its database code, HTTP status, digest or class name (never its message). */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; status?: unknown; digest?: unknown; name?: unknown };
    // Database, PostgREST and Node codes are strings; a numeric `code` (DOMException's legacy codes) says
    // less than its name. An HTTP status may be a number.
    for (const value of [typeof e.code === "string" ? e.code : undefined, e.digest, e.status]) {
      if ((typeof value === "string" || typeof value === "number") && SAFE_CODE.test(String(value))) return String(value);
    }
    if (typeof e.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name)) return e.name;
  }
  return "unknown";
}

/** Writes one structured log line. Never throws. */
export function logEvent(event: LogEvent): void {
  try {
    const line = JSON.stringify({
      source: "flux-dj",
      ts: new Date().toISOString(),
      level: event.level,
      category: event.category,
      operation: redact(event.operation, 200),
      // Codes are short identifiers (a digest correlates with the error page's own digest): validated, not redacted.
      ...(event.code && SAFE_CODE.test(event.code) ? { code: event.code } : event.code ? { code: "invalid" } : {}),
      ...(event.id && /^[0-9a-f-]{36}$/i.test(event.id) ? { id: event.id } : {}),
      ...(event.detail ? { detail: redact(event.detail) } : {}),
    });
    if (event.level === "warn") console.warn(line);
    else console.error(line);
  } catch {
    // Logging must never break the work it reports on.
  }
}
