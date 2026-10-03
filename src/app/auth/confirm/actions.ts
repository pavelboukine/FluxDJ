"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Verifies a magic-link token. Runs only on an explicit POST from the confirm
 * page, so link scanners that merely GET the URL cannot consume the token.
 */
export async function confirmSignIn(form: FormData) {
  const tokenHash = String(form.get("token_hash") ?? "");
  // Links requested through the server client use the PKCE flow and carry a "pkce_" prefix.
  if (!/^(pkce_)?[0-9a-f]{20,128}$/i.test(tokenHash)) redirect("/login?error=link");

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error) redirect("/login?error=link");
  redirect("/staff");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
