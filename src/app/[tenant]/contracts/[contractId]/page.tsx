import type { Metadata } from "next";
import { PdfDownloadLink } from "@/components/app/pwa";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContractDocument } from "@/components/contract/contract-document";
import { renderedContentSchema } from "@/lib/contracts/content";
import { UUID_RE } from "@/lib/forms";
import { formatCents } from "@/lib/money";
import { SLUG_PATTERN } from "@/lib/proposals/client-session.server";
import { SIGNATURE_BUCKET } from "@/lib/contracts/signing";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { InvoiceLink, PaymentFigures } from "@/components/payments/payment-summary";
import type { ClientPaymentSummary } from "@/lib/payments";
import { SignPanel } from "./sign-panel";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandStyle } from "@/lib/branding/colors";
import { liveBrand } from "@/lib/branding/logo.server";

export const metadata: Metadata = { title: "Your contract", robots: { index: false, follow: false }, referrer: "strict-origin" };

type View =
  | { state: "unavailable" }
  | {
      state: "available";
      brand: { display_name: string; brand_colors: { primary?: string; accent?: string } };
      contract: {
        id: string; status: "sent" | "signed"; sent_at: string; content_sha256: string; rendered_content: unknown; signer_name: string; currency: string;
        total_cents: number; deposit_percent: number; deposit_cents: number; balance_cents: number; balance_due_date: string | null;
        signing_mode: "demo" | "client_use" | "none";
        event_title: string; event_date: string; legal_name: string;
      };
      signing:
        | { signed: true; typed_name: string; signed_at: string; pdf_ready: boolean; pdf_pending: boolean }
        | { signed: false; enabled: boolean; consent_version: string | null; consent_text: string | null };
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
 * The client's contract. Every request is checked in the database: verified
 * identity, event access, intended signer, and that the contract is still
 * sent and current (or signed) and not archived. Only frozen contract data is
 * shown. The signer signs here; once signed, the page shows who signed and
 * when, and the signature image through a short-lived link.
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
  const pageStyle = brandStyle(view.brand.brand_colors.primary);
  // Live branding (current logo), shown only after the access check above.
  const brandLogo = (await liveBrand(slug))?.logo ?? null;
  // From the contract's frozen signing mode, never from its wording.
  const isDemo = c.signing_mode === "demo";
  const signing = view.signing;
  // Read-only, for the same verified access as the contract itself.
  const { data: paymentData } = await supabase.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: slug });
  const payments = paymentData as ClientPaymentSummary | null;
  // Planning opens once the booking is confirmed; the database decides.
  const plan = signing.signed ? ((await supabase.rpc("my_plans")).data ?? []).find((p) => p.contract_id === contractId) : undefined;
  let signatureUrl: string | null = null;
  if (signing.signed) {
    // Authorized in the database for this signer only; the link lasts two minutes.
    const { data: path } = await supabase.rpc("client_signature_object", { p_contract_id: contractId, p_tenant_slug: slug });
    if (path) signatureUrl = (await createAdminClient().storage.from(SIGNATURE_BUCKET).createSignedUrl(path, 120)).data?.signedUrl ?? null;
  }

  return (
    <main style={pageStyle} className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
      <header className="grid gap-1 border-b-4 border-[var(--brand)] pb-4">
        <div className="flex min-h-6 items-center text-sm font-semibold">
          <BrandLogo logo={brandLogo} name={view.brand.display_name} className="max-h-12 max-w-48" />
        </div>
        <p className="text-sm text-muted-foreground">Contract for {c.event_title} · {c.event_date} · sent {new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(c.sent_at))}</p>
      </header>
      {isDemo ? (
        <p role="alert" className="rounded-lg border-2 border-destructive p-3 text-sm font-semibold text-destructive">
          DEMO, NOT FOR CLIENT USE. This is test wording, not a real agreement.
        </p>
      ) : null}
      {signing.signed ? (
        <section role="status" className="grid gap-2 rounded-lg border-2 border-emerald-600 p-4 text-base">
          <h2 className="text-lg font-semibold">Contract signed.</h2>
          {payments?.booking_status === "booked" ? (
            <p className="font-medium">Your booking is confirmed.</p>
          ) : payments?.booking_status === "awaiting_deposit" ? (
            <p>
              Your booking will be confirmed once {view.brand.display_name} has recorded your deposit
              {payments.deposit_outstanding_cents ? ` (${money(payments.deposit_outstanding_cents)} still to pay)` : ""}.
            </p>
          ) : null}
          {plan ? (
            <p>
              <Link className="font-medium underline" href={`/${slug}/planning/${plan.event_id}`}>Plan your event</Link>: event basics now,
              with more sections to come.
            </p>
          ) : (
            <p>Your DJ will follow up with the next steps.</p>
          )}
          <p className="text-sm text-muted-foreground">
            {/* en-CA times end in "p.m.", so no extra full stop is added. */}
            Signed by {signing.typed_name} on {new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short" }).format(new Date(signing.signed_at)).replace(/\.?$/, ".")}
          </p>
          {signing.pdf_ready ? (
            <PdfDownloadLink
              className="rounded-lg bg-[var(--brand)] px-3 py-2 text-sm font-medium text-[var(--brand-foreground)] underline-offset-2 hover:underline"
              href={`/${slug}/contracts/${contractId}/signed-pdf`}
              fallbackName="signed-contract.pdf"
            >
              Download signed PDF
            </PdfDownloadLink>
          ) : signing.pdf_pending ? (
            <p className="text-sm text-muted-foreground">Your signed PDF is being prepared. Reload this page in a minute to download it.</p>
          ) : null}
          {signatureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimizable asset
            <img src={signatureUrl} alt={`Signature of ${signing.typed_name}`} className="h-24 w-auto max-w-full self-start rounded border bg-white" />
          ) : null}
        </section>
      ) : !signing.enabled ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Please read your contract. It can&apos;t be signed online; {view.brand.display_name} will send you an updated contract to sign.
        </p>
      ) : null}
      <ContractDocument title={content.title} sections={content.sections} />
      <section className="mx-auto grid w-full max-w-prose gap-1 rounded-lg border p-4 text-base">
        <h2 className="font-semibold">Payment terms</h2>
        <div className="flex justify-between gap-2"><span>Total, including taxes</span><span className="tabular-nums">{money(c.total_cents)}</span></div>
        <div className="flex justify-between gap-2"><span>Deposit on signing ({c.deposit_percent}%)</span><span className="tabular-nums">{money(c.deposit_cents)}</span></div>
        <div className="flex justify-between gap-2"><span>Balance</span><span className="tabular-nums">{money(c.balance_cents)}</span></div>
        {c.balance_due_date ? <div className="flex justify-between gap-2"><span>Balance due</span><span>{c.balance_due_date}</span></div> : null}
      </section>
      {payments ? (
        <section aria-labelledby="payments-heading" className="mx-auto grid w-full max-w-prose gap-2 rounded-lg border p-4 text-base">
          <h2 id="payments-heading" className="font-semibold">Payments</h2>
          <PaymentFigures
            audience="client"
            s={{
              currency: payments.currency,
              termsStatus: payments.terms_status,
              totalCents: payments.total_cents,
              depositPercent: payments.deposit_percent,
              depositCents: payments.deposit_cents,
              balanceDueDate: payments.balance_due_date,
              receivedCents: payments.received_cents,
              depositOutstandingCents: payments.deposit_outstanding_cents,
              remainingBalanceCents: payments.remaining_balance_cents,
              creditCents: payments.credit_cents,
            }}
          />
          {payments.invoice_url ? <p className="text-sm"><InvoiceLink url={payments.invoice_url} /></p> : null}
          <p className="text-xs text-muted-foreground">
            Payments are recorded by hand by {view.brand.display_name} when they receive them, so a recent payment may not appear yet. Pay
            only as arranged with {view.brand.display_name}; Flux DJ doesn&apos;t take payments.
          </p>
        </section>
      ) : null}
      {!signing.signed && signing.enabled && signing.consent_version && signing.consent_text ? (
        <SignPanel
          slug={slug}
          contractId={c.id}
          contentSha256={c.content_sha256}
          consentVersion={signing.consent_version}
          consentText={signing.consent_text}
          isDemo={isDemo}
          expectedName={c.signer_name}
        />
      ) : null}
      <p className="mx-auto max-w-prose text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {c.legal_name} · Contract fingerprint (SHA-256): {c.content_sha256}
      </p>
      <p className="text-xs text-muted-foreground">
        <Link className="underline" href="/my">Your events and contracts</Link>
      </p>
    </main>
  );
}
