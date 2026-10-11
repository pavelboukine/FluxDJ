/**
 * Where a confirmed sign-in may continue to. Only these same-site paths are
 * allowed; anything else (other hosts, protocol-relative URLs, encoded
 * tricks) falls back to the default.
 */
const ALLOWED = [
  /^\/staff(?:\/[a-z0-9-]+(?:\/[A-Za-z0-9/_-]*)?)?$/,
  /^\/my$/,
  /^\/platform\/(?:invitations|workspaces)$/,
  /^\/join\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/join\/team\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/invitations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/contracts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/planning\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
];

export function safeNext(value: unknown, fallback = "/staff"): string {
  if (typeof value !== "string") return fallback;
  return ALLOWED.some((re) => re.test(value)) ? value : fallback;
}

/** Supabase verification types this app sends: staff/returning magic links ("email") and first-time client invites. */
export function safeOtpType(value: unknown): "email" | "invite" {
  return value === "invite" ? "invite" : "email";
}

/** Who the sign-in page is worded for. Presentation only: it never grants or implies access. */
export type SignInRole = "dj" | "client";

export function signInRole(value: unknown): SignInRole | null {
  return value === "dj" || value === "client" ? value : null;
}

/** An allow-listed destination, or null (no fallback): for remembering where a sign-in should continue. */
export function allowedNext(value: unknown): string | null {
  return typeof value === "string" && ALLOWED.some((re) => re.test(value)) ? value : null;
}

/** The sign-in page for a role, continuing to `next` afterwards when it is an allowed destination. */
export function loginHref(role: SignInRole, next?: string | null): string {
  const params = new URLSearchParams({ role });
  const allowed = allowedNext(next);
  if (allowed) params.set("next", allowed);
  return `/login?${params.toString()}`;
}

/** Where a sign-in continues: the requested destination if allowed, else the role's home (clients: /my), else /staff (which sends clients to /my). */
export function signInDestination(role: SignInRole | null, next: unknown): string {
  return allowedNext(next) ?? (role === "client" ? "/my" : "/staff");
}

/**
 * The destination a sign-in email carried: Supabase passes the address the
 * sign-in form asked for (emailRedirectTo, this app's /auth/confirm?next=…)
 * to the email template as redirect_to, after checking it against the
 * project's allowed URLs. Only this app's own origin counts, and its `next`
 * must still be allow-listed; anything else is null.
 */
export function nextFromRedirectTo(value: unknown, appUrl: string): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(appUrl).origin) return null;
    return allowedNext(url.searchParams.get("next"));
  } catch {
    return null;
  }
}

/** The sign-in page to come back to after a link failed, keeping a destination that isn't the default. */
export function retrySignInHref(next: string): string {
  if (next === "/staff") return "/login?error=link";
  const role: SignInRole = /^\/(staff|join|platform)(\/|$)/.test(next) ? "dj" : "client";
  return `${loginHref(role, next)}&error=link`;
}
