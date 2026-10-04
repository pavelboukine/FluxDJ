import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContractDocument } from "@/components/contract/contract-document";
import { renderedContentSchema } from "@/lib/contracts/content";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

type View =
  | { state: "unavailable" }
  | {
      state: "available";
      brand: { display_name: string; brand_colors: { primary?: string; accent?: string } };
      contract: {
        id: string; sent_at: string; content_sha256: string; rendered_content: unknown; signer_name: string; currency: string;
        total_cents: number; deposit_percent: number; deposit_cents: number; balance_cents: number; balance_due_date: string | null;
        event_title: string; event_date: string; legal_name: string;
      };
    };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-4 py-16 text-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

/**
 * The client's read-only contract. Every request is checked in the database:
 * verified identity, event access, intended signer, and that the contract is
 * still sent, current and not archived. Only frozen contract data is shown.
 */
export default async function ClientContractPage({ params }: PageProps<"/[tenant]/contracts/[contractId]">) {
  const { tenant: slug, contractId } = await params;
  if (!SLUG_PATTERN.test(slug) || !UUID_RE.test(contractId)) notFound();
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <Notice title="Sign in to read your contract">
        <p>Your contract is private. <Link className="underline" href="/login">Sign in with your email</Link> to read it.</p>
      </Notice>
    );
  }
  const { data } = await supabase.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: slug });
  const view = (data as View | null) ?? { state: "unavailable" };
  if (view.state !== "available") {
    return (
      <Notice title="This contract isn't available">
        <p>It may have been replaced or cancelled, or this account can&apos;t open it. Use the most recent email from your DJ, or see <Link className="underline" href="/my">your contracts</Link>.</p>
      </Notice>
    );
  }
  const c = view.contract;
  const content = renderedContentSchema.parse(c.rendered_content);
  const money = (cents: number) => formatCents(cents, c.currency);
  const brandStyle = { "--brand": view.brand.brand_colors.primary ?? "#111827" } as CSSProperties;
  const isDemo = /DEMO, NOT FOR CLIENT USE/.test(content.title);

  return (
    <main style={brandStyle} className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
      <header className="grid gap-1 border-b-4 border-[var(--brand)] pb-4">
        <p className="text-sm font-semibold">{view.brand.display_name}</p>
        <p className="text-sm text-muted-foreground">Contract for {c.event_title} · {c.event_date} · sent {new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(c.sent_at))}</p>
      </header>
      {isDemo ? (
        <p role="alert" className="rounded-lg border-2 border-destructive p-3 text-sm font-semibold text-destructive">
          DEMO, NOT FOR CLIENT USE. This is test wording, not a real agreement.
        </p>
      ) : null}
      <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
        Please read your contract. Online signing isn&apos;t available yet, so there is nothing to sign here; {view.brand.display_name} will let you
        know when it is.
      </p>
      <ContractDocument title={content.title} sections={content.sections} />
      <section className="mx-auto grid w-full max-w-prose gap-1 rounded-lg border p-4 text-base">
        <h2 className="font-semibold">Payment terms</h2>
        <div className="flex justify-between gap-2"><span>Total, including taxes</span><span className="tabular-nums">{money(c.total_cents)}</span></div>
        <div className="flex justify-between gap-2"><span>Deposit on signing ({c.deposit_percent}%)</span><span className="tabular-nums">{money(c.deposit_cents)}</span></div>
        <div className="flex justify-between gap-2"><span>Balance</span><span className="tabular-nums">{money(c.balance_cents)}</span></div>
        {c.balance_due_date ? <div className="flex justify-between gap-2"><span>Balance due</span><span>{c.balance_due_date}</span></div> : null}
      </section>
      <p className="mx-auto max-w-prose text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {c.legal_name} · Contract fingerprint (SHA-256): {c.content_sha256}
      </p>
    </main>
  );
}
