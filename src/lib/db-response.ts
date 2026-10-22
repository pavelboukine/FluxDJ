import { z } from "zod";
import { logEvent } from "@/lib/observability";

/**
 * Validation of JSON returned by database functions, at the boundaries where
 * the app acts on it or shows money, contract or booking state (generated
 * types say only `Json` there). The database stays the authority: these
 * schemas only refuse a response that doesn't have the shape and invariants
 * the database guarantees, so a broken or mismatched response is never shown
 * or acted on. Fields the app treats generically stay lenient, so an additive
 * migration (deployed before the app) doesn't break the running app.
 *
 * A failure is logged once (the function name and the failing field paths and
 * issue codes, never a value), then the caller fails safely: it shows nothing
 * rather than a substitute figure.
 */

/** Integer cents within the safe integer range (database bigint sums fit). */
export const centsSchema = z.int().nonnegative();
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
/** A database id (any 8-4-4-4-12 hex form; seeded ids aren't always version 4). */
export const idSchema = z.guid();
/** A Postgres `date`, as JSON gives it. */
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A Postgres `timestamptz`, as JSON gives it ("2026-10-22T17:11:12.123456+00:00"). */
export const timestampSchema = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not a timestamp");

/** A database response that failed validation. Its message names fields and issue codes only. */
export class DbResponseError extends Error {
  constructor(readonly operation: string, readonly issues: string) {
    super(`${operation} returned an unexpected response (${issues})`);
    this.name = "DbResponseError";
  }
}

/** "terms.total_cents: invalid_type; signing: invalid_union": where and what kind, never the values. */
export function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.code}`);
  return error.issues.length > shown.length ? `${shown.join("; ")}; +${error.issues.length - shown.length} more` : shown.join("; ");
}

/** Validates `data`; on failure logs it once and returns ok: false. `operation` names the database function. */
export function checkDbResponse<S extends z.ZodType>(schema: S, data: unknown, operation: string): { ok: true; data: z.output<S> } | { ok: false; issues: string } {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = describeIssues(parsed.error);
  logEvent({ level: "error", category: "data", operation, code: "invalid_response", detail: issues });
  return { ok: false, issues };
}

/** Validates `data` or throws DbResponseError (for pages, where the error page is the safe outcome). */
export function parseDbResponse<S extends z.ZodType>(schema: S, data: unknown, operation: string): z.output<S> {
  const checked = checkDbResponse(schema, data, operation);
  if (!checked.ok) throw new DbResponseError(operation, checked.issues);
  return checked.data;
}
