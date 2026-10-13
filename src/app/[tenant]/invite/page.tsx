import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileSignature } from "lucide-react";
import { PublicCard } from "@/components/app/public-shell";
import { createAdminClient } from "@/lib/supabase/admin";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { InviteRequest } from "./invite-request";

export const metadata: Metadata = { title: "Your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

export default async function ContractInvitation({ params }: PageProps<"/[tenant]/invite">) {
  const { tenant: slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  const brand = (data as { display_name?: string } | null)?.display_name;
  if (!brand) notFound();
  return (
    <PublicCard icon={FileSignature} title={`Your contract from ${brand}`}>
      <InviteRequest slug={slug} brand={brand} />
      <noscript>
        <p>
          This first step needs JavaScript, because the invitation code stays in your browser. If you already confirmed your email
          before, you can <Link className="underline" href="/login">sign in here</Link> instead.
        </p>
      </noscript>
    </PublicCard>
  );
}
