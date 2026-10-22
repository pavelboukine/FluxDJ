"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { emailAddress, fail, ok, type ActionState } from "@/lib/forms";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";
import { signInDestination, signInRole } from "@/lib/auth/redirects";
import { SIGN_IN_NEXT_COOKIE } from "@/lib/auth/sign-in-next";

/** This app's /auth/confirm, with the destination when it isn't the default. */
const confirmUrl = (destination: string) =>
  `${publicEnv().NEXT_PUBLIC_APP_URL}/auth/confirm${destination === "/staff" ? "" : `?next=${encodeURIComponent(destination)}`}`;

/**
 * Sends a sign-in link (and code) to DJs and clients alike. Never creates
 * accounts (they are created by trusted code: invitations, contract sending)
 * and always answers the same way, so the form does not reveal which emails
 * have accounts. The role only words the page; access is checked by every page.
 */
export async function sendMagicLink(_state: ActionState, form: FormData): Promise<ActionState> {
  const email = emailAddress(String(form.get("email") ?? ""));
  if (!email) return fail("Enter a valid email address.");

  // Durable per-IP limit, in addition to Supabase's own per-email limits.
  if (!(await allowRequest("sign_in_link", await clientIp(), 30, 600))) {
    return fail("Too many sign-in requests. Wait a few minutes and try again.");
  }
  const destination = signInDestination(signInRole(form.get("role")), form.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    // The destination travels in the email too (redirect_to, read by /auth/confirm once the email
    // template includes it), so a link opened in another browser or app still continues there.
    options: { shouldCreateUser: false, emailRedirectTo: confirmUrl(destination) },
  });
  if (error && error.status === 429) return fail("Too many sign-in requests. Wait a minute and try again.");
  // This browser also remembers the destination for an hour, for emails whose template doesn't
  // carry it yet: a contract or planning page, or /my for the client sign-in. Allow-listed paths
  // only, checked again when the link is confirmed; HttpOnly, this site only.
  const jar = await cookies();
  if (destination === "/staff") jar.delete({ name: SIGN_IN_NEXT_COOKIE, path: "/auth/confirm" });
  else {
    jar.set(SIGN_IN_NEXT_COOKIE, destination, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicEnv().NEXT_PUBLIC_APP_URL.startsWith("https://"),
      path: "/auth/confirm",
      maxAge: 3600,
    });
  }
  return ok("If that email has a Flux DJ account, a sign-in link is on its way. It expires in one hour.");
}

/**
 * Signs in with the 6-digit code from the same email, in whichever browser or
 * home-screen app it is typed (a tapped link opens the default browser, which
 * on iPhone does not sign in an app added to the Home Screen). No password,
 * nothing kept in browser storage: Supabase verifies the code and sets this
 * session's cookie. Limited per IP on top of Supabase's own verification
 * limits; never creates accounts.
 */
export async function verifySignInCode(_state: ActionState, form: FormData): Promise<ActionState> {
  const email = emailAddress(String(form.get("email") ?? ""));
  const code = String(form.get("code") ?? "").replace(/\s+/g, "");
  if (!email) return fail("Enter your email address again, then request a new code.");
  if (!/^[0-9]{6,10}$/.test(code)) return fail("Enter the code from the email (digits only).");
  if (!(await allowRequest("sign_in_code", await clientIp(), 20, 900))) {
    return fail("Too many code attempts. Wait 15 minutes, or use the link in the email.");
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) return fail("That code is wrong or has expired. Check the newest email, or request a new one.");
  (await cookies()).delete({ name: SIGN_IN_NEXT_COOKIE, path: "/auth/confirm" });
  // Back to the page that asked for sign-in (allow-listed), else the role's home.
  redirect(signInDestination(signInRole(form.get("role")), form.get("next")));
}
