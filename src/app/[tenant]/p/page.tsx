import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { PublicCard } from "@/components/app/public-shell";
import { LinkOpener } from "./link-opener";

export const metadata: Metadata = { title: "Your proposal", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function OpenProposalLink({ params }: PageProps<"/[tenant]/p">) {
  const { tenant } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(tenant)) notFound();
  return (
    <PublicCard icon={FileText} title="Your proposal">
      <LinkOpener slug={tenant} />
    </PublicCard>
  );
}
