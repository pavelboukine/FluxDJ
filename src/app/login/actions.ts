"use server";

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
