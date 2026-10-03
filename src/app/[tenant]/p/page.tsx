import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkOpener } from "./link-opener";

export const metadata: Metadata = { title: "Your proposal", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function OpenProposalLink({ params }: PageProps<"/[tenant]/p">) {
  const { tenant } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(tenant)) notFound();
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <LinkOpener slug={tenant} />
    </main>
  );
}
