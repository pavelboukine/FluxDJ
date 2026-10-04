/**
 * Where a confirmed sign-in may continue to. Only these same-site paths are
 * allowed; anything else (other hosts, protocol-relative URLs, encoded
 * tricks) falls back to the default.
 */
const ALLOWED = [
  /^\/staff(?:\/[a-z0-9-]+(?:\/[A-Za-z0-9/_-]*)?)?$/,
  /^\/my$/,
  /^\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/invitations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/contracts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
];

export function safeNext(value: unknown, fallback = "/staff"): string {
  if (typeof value !== "string") return fallback;
  return ALLOWED.some((re) => re.test(value)) ? value : fallback;
}

/** Supabase verification types this app sends: staff/returning magic links ("email") and first-time client invites. */
export function safeOtpType(value: unknown): "email" | "invite" {
  return value === "invite" ? "invite" : "email";
}
