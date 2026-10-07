import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Where the installed app opens (the manifest's start_url). Neutral: no
 * business, event or token in the URL. Signed out: the sign-in page.
 * Signed in: /staff, which already sends one-business staff to their
 * dashboard, several businesses to the chooser, and clients (no staff role)
 * to /my. Permissions are unchanged; every page checks them again. A
 * relative redirect keeps the host the browser used (and so its cookies).
 */
export default async function Start() {
  const { data } = await (await createClient()).auth.getUser();
  redirect(data.user ? "/staff" : "/login");
}
