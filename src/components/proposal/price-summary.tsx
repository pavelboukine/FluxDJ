import type { ReactNode } from "react";
import type { PricedSelection } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

export function taxRateLabel(ratePpm: number): string {
  return `${(ratePpm / 10_000).toLocaleString("en-CA", { maximumFractionDigits: 4 })}%`;
}

/**
 * The price of a selection, straight from the shared pricing result: the
 * package's one price, the equipment it includes (never charged), each
 * chargeable addition, subtotal, each tax and the total. Nothing here adds
 * or rounds money itself.
 */
export function PriceLines({ priced, className }: { priced: PricedSelection; className?: string }) {
  const money = (cents: number) => formatCents(cents, priced.currency);
  const pkg = priced.lines.find((l) => l.source === "package");
  const included = priced.lines.filter((l) => l.source === "included");
  const additions = priced.lines.filter((l) => (l.source === "optional" || l.source === "required") && l.quantity > 0);
  const taxes = priced.tax_breakdown.filter((t) => t.amount_cents > 0);
  return (
    <dl className={cn("grid gap-2 text-sm", className)}>
      {pkg ? (
        <div className="grid gap-0.5">
          <div className="flex justify-between gap-3">
            <dt className="font-medium">{pkg.name} package</dt>
            <dd className="tabular-nums">{money(pkg.line_total_cents)}</dd>
          </div>
          {included.length > 0 ? (
            <dd className="text-xs text-muted-foreground">
              Includes {included.map((l) => `${l.quantity} × ${l.name}`).join(", ")} at no extra charge.
            </dd>
          ) : null}
        </div>
      ) : null}
      {additions.map((l) => (
        <div key={`${l.source}-${l.item_key}`} className="flex justify-between gap-3">
          <dt className="min-w-0">
            {l.quantity} × {l.name}
            {l.source === "required" ? <span className="text-muted-foreground"> (required)</span> : null}
            <span className="block text-xs text-muted-foreground">{money(l.unit_price_cents)} each</span>
          </dt>
          <dd className="tabular-nums">{money(l.line_total_cents)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t pt-2">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{money(priced.subtotal_cents)}</dd>
      </div>
      {taxes.map((t) => (
        <div key={t.code} className="flex justify-between gap-3 text-muted-foreground">
          <dt>
            {t.label} ({taxRateLabel(t.rate_ppm)})
          </dt>
          <dd className="tabular-nums">{money(t.amount_cents)}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-3 border-t pt-2">
        <dt className="text-base font-semibold">Total</dt>
        <dd className="text-lg font-semibold tabular-nums">{money(priced.total_cents)}</dd>
      </div>
    </dl>
  );
}

/** A titled price card with optional actions underneath (save status, review button). */
export function PriceSummaryCard({
  id,
  title,
  headingLevel = 2,
  priced,
  provisional,
  problems,
  children,
}: {
  id?: string;
  title: string;
  headingLevel?: 2 | 3;
  priced: PricedSelection | null;
  /** Shown while required answers are missing (the price is computed as if they were optional). */
  provisional?: boolean;
  /** Client-safe pricing messages (for example a quantity out of range). */
  problems?: string[];
  children?: ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section id={id} aria-labelledby={id ? `${id}-heading` : undefined} className="grid scroll-mt-4 gap-3 rounded-2xl border-2 bg-card p-4 shadow-sm" style={{ borderColor: "var(--brand)" }}>
      <Heading id={id ? `${id}-heading` : undefined} className="text-base font-semibold">
        {title}
      </Heading>
      {problems && problems.length > 0 ? (
        <ul role="alert" className="grid gap-1 text-sm text-destructive">
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {priced ? <PriceLines priced={priced} /> : <p className="text-sm text-muted-foreground">Choose a package to see your price.</p>}
      {priced && provisional ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Provisional: answer the required questions to confirm your total. Some answers can add equipment.
        </p>
      ) : null}
      {children}
    </section>
  );
}
