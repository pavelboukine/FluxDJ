/**
 * The cookie that remembers, for one hour and on this browser only, where a
 * requested sign-in link should continue (set by the sign-in form, read and
 * re-validated by /auth/confirm when the link itself names no destination).
 * Scoped to /auth/confirm and HttpOnly.
 */
export const SIGN_IN_NEXT_COOKIE = "flux_sign_in_next";
