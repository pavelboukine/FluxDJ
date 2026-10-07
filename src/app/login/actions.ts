"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { fail, ok, type ActionState } from "@/lib/forms";
import { allowRequest, clientIp } from "@/lib/rate-limit.server";

const emailSchema = z.email().max(320);

/**
 * Sends a staff magic link. Never creates accounts (staff are created by
 * trusted code) and always answers the same way, so the form does not reveal
 * which emails have accounts.
 */
export async function sendMagicLink(_state: ActionState, form: FormData): Promise<ActionState> {
  const parsed = emailSchema.safeParse(String(form.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) return fail("Enter a valid email address.");

  // Durable per-IP limit, in addition to Supabase's own per-email limits.
  if (!(await allowRequest("sign_in_link", await clientIp(), 30, 600))) {
    return fail("Too many sign-in requests. Wait a few minutes and try again.");
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { shouldCreateUser: false, emailRedirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/auth/confirm` },
  });
  if (error && error.status === 429) return fail("Too many sign-in requests. Wait a minute and try again.");
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
  const email = emailSchema.safeParse(String(form.get("email") ?? "").trim().toLowerCase());
  const code = String(form.get("code") ?? "").replace(/\s+/g, "");
  if (!email.success) return fail("Enter your email address again, then request a new code.");
  if (!/^[0-9]{6,10}$/.test(code)) return fail("Enter the code from the email (digits only).");
  if (!(await allowRequest("sign_in_code", await clientIp(), 20, 900))) {
    return fail("Too many code attempts. Wait 15 minutes, or use the link in the email.");
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: email.data, token: code, type: "email" });
  if (error) return fail("That code is wrong or has expired. Check the newest email, or request a new one.");
  redirect("/start");
}
