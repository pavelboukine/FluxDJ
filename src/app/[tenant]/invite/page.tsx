import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { InviteRequest } from "./invite-request";

export const metadata: Metadata = { title: "Your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

/**
 * The link in a contract email: ask for a verification email (or continue, if already signed in as the signer).
 * Opening it changes nothing. Nothing about the business, event or client is rendered here: the token stays in the
 * URL fragment, and the business's branding appears only after the server matches it to a usable invitation.
 */
export default async function ContractInvitation({ params }: PageProps<"/[tenant]/invite">) {
  const { tenant: slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
  // Unknown, archived or suspended businesses: no page at all, as before.
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  if (!(data as { display_name?: string } | null)?.display_name) notFound();
  return (
    <InviteRequest
      slug={slug}
      noscript={
        <noscript>
          <p className="mt-3 max-w-sm text-center text-sm">
            This first step needs JavaScript, because the invitation code stays in your browser. If you already confirmed your email
            before, you can <Link className="underline" href="/login">sign in here</Link> instead.
          </p>
        </noscript>
      }
    />
  );
}
