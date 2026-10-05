import { formatCents } from "@/lib/money";
import { linkHost } from "@/lib/payments";

/** The figures both staff and clients see; computed in the database. */
export type SummaryFigures = {
  currency: string;
  termsStatus: "signed" | "sent" | null;
  totalCents: number | null;
  depositPercent: number | null;
  depositCents: number | null;
  balanceDueDate: string | null;
  receivedCents: number;
  depositOutstandingCents: number | null;
  remainingBalanceCents: number | null;
  creditCents: number | null;
};

function Row({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Payment terms and what has been received. Overpayment is a credit, never a
 * negative amount due. Without authoritative contract terms, only the
 * received amount is shown: no total or deposit is invented.
 */
export function PaymentFigures({ s, audience }: { s: SummaryFigures; audience: "staff" | "client" }) {
  const money = (cents: number) => formatCents(cents, s.currency);
  const hasTerms = s.termsStatus !== null && s.totalCents !== null;
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-muted-foreground">
        {s.termsStatus === "signed"
          ? "Terms of the signed contract. They don't change."
          : s.termsStatus === "sent"
            ? audience === "staff"
              ? "Terms of the contract sent to the client. It isn't signed yet, so these terms change if it is voided and replaced."
              : "Terms of the contract sent to you. It isn't signed yet."
            : audience === "staff"
              ? "No contract has been sent yet, so there is no total or deposit to compare. Recorded payments are still listed."
              : "There are no payment terms yet."}
      </p>
      <dl className="grid gap-1">
        {hasTerms ? (
          <>
            <Row label="Total, including taxes">{money(s.totalCents!)}</Row>
            <Row label={s.depositCents ? `Deposit required (${s.depositPercent}%)` : "Deposit required"}>
              {s.depositCents ? money(s.depositCents) : "No deposit required"}
            </Row>
          </>
        ) : null}
        <Row label="Received so far" strong>{money(s.receivedCents)}</Row>
        {hasTerms ? (
          <>
            {s.depositCents ? (
              <Row label="Deposit still outstanding">
                {s.depositOutstandingCents ? money(s.depositOutstandingCents) : "Deposit received in full"}
              </Row>
            ) : null}
            <Row label="Remaining balance" strong>{s.remainingBalanceCents ? money(s.remainingBalanceCents) : "Paid in full"}</Row>
            {s.creditCents ? <Row label="Received above the total (credit)">{money(s.creditCents)}</Row> : null}
            <Row label="Balance due">{s.balanceDueDate ?? "Not specified in the contract"}</Row>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** An external invoice link, shown with its host. Never fetched or embedded. */
export function InvoiceLink({ url }: { url: string }) {
  return (
    <a className="underline" href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
      View invoice ({linkHost(url)})
    </a>
  );
}
