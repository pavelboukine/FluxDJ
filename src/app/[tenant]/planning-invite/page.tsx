import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { PublicCard } from "@/components/app/public-shell";
import { createAdminClient } from "@/lib/supabase/admin";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { PlanningInviteRequest } from "./planning-invite-request";

export const metadata: Metadata = { title: "Plan your event", robots: { index: false, follow: false }, referrer: "strict-origin" };

/** The link in a planning invitation (an event booked elsewhere): ask for a verification email. Opening it changes nothing. */
export default async function PlanningInvitation({ params }: PageProps<"/[tenant]/planning-invite">) {
  const { tenant: slug } = await params;
  if (!SLUG_PATTERN.test(slug)) notFound();
  const { data } = await createAdminClient().rpc("public_tenant_brand", { p_tenant_slug: slug });
  const brand = (data as { display_name?: string } | null)?.display_name;
  if (!brand) notFound();
  return (
    <PublicCard icon={ClipboardList} title={`Plan your event with ${brand}`}>
      <PlanningInviteRequest slug={slug} brand={brand} />
      <noscript>
        <p>
          This first step needs JavaScript, because the invitation code stays in your browser. If you already confirmed your email
          before, you can <Link className="underline" href="/login?role=client">sign in here</Link> instead.
        </p>
      </noscript>
    </PublicCard>
  );
}
