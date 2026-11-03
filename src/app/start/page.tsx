import { redirect } from "next/navigation";
import { staffLanding } from "@/lib/auth/landing";

/**
 * Where the installed app opens (the manifest's start_url). Neutral: no
 * business, event or token in the URL. Signed out: the sign-in page (from
 * requireUser). Signed in: straight to where /staff would send them (one
 * business's dashboard, platform administration, or /my for clients), so
 * the app opens with one redirect instead of two; several businesses go to
 * the /staff chooser. Permissions are unchanged; every page checks them
 * again. A relative redirect keeps the host the browser used (and so its cookies).
 */
export default async function Start() {
  const landing = await staffLanding();
  redirect("redirect" in landing ? landing.redirect : "/staff");
}
