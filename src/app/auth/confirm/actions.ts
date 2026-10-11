"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { retrySignInHref, safeNext, safeOtpType } from "@/lib/auth/redirects";
import { SIGN_IN_NEXT_COOKIE } from "@/lib/auth/sign-in-next";

/**
 * Verifies a magic-link token. Runs only on an explicit POST from the confirm
 * page, so link scanners that merely GET the URL cannot consume the token.
 */
export async function confirmSignIn(form: FormData) {
  const tokenHash = String(form.get("token_hash") ?? "");
  // Links requested through the server client use the PKCE flow and carry a "pkce_" prefix.
  if (!/^(pkce_)?[0-9a-f]{20,128}$/i.test(tokenHash)) redirect("/login?error=link");

  const supabase = await createClient();
  // The type and destination come from the form, so both are re-validated:
  // only "email" or "invite", and only allow-listed same-site paths.
  const next = safeNext(form.get("next"));
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: safeOtpType(form.get("type")) });
  // Expired, used or wrong: back to sign-in to request a new link, keeping where it was going.
  if (error) redirect(retrySignInHref(next));
  (await cookies()).delete({ name: SIGN_IN_NEXT_COOKIE, path: "/auth/confirm" });
  redirect(next);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
