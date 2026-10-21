import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loginHref } from "@/lib/auth/redirects";
import { eventHubPath } from "@/lib/client-event";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your events", robots: { index: false, follow: false } };

/**
 * Where the client sign-in lands when no page asked for one: a client with
 * exactly one event goes straight to its hub; several or none, to /my. The
 * list is the same my_events view /my and the hub read (verified, unrevoked
 * access, never archived or suspended), so the hub always opens what this
 * picks. It only chooses between pages that check access themselves.
 */
export default async function ContinueAfterSignIn() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(loginHref("client"));
  const { data: events } = await supabase.rpc("my_events");
  const only = events?.length === 1 ? events[0] : null;
  redirect(only ? eventHubPath(only.tenant_slug, only.event_id) : "/my");
}
