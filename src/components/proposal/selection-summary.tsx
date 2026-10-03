import type { OfferSnapshot, PricedSelection } from "@/lib/pricing";
import { formatCents } from "@/lib/money";

function answerLabel(offer: OfferSnapshot, key: string, value: unknown): string {
  const question = offer.questions.find((q) => q.key === key);
  const label = (v: unknown) => question?.options.find((o) => o.value === v)?.label ?? String(v);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(label).join(", ") : "None";
  return label(value);
}

/** The exact submitted selection: package, extras, required gear, answers and totals. */
export function SelectionSummary({ offer, selection }: { offer: OfferSnapshot; selection: PricedSelection }) {
  const money = (cents: number) => formatCents(cents, selection.currency);
  const pkg = offer.packages.find((p) => p.key === selection.package_key);
  const charged = selection.lines.filter((l) => l.line_total_cents > 0);
  const included = selection.lines.filter((l) => l.source === "included");
  return (
    <div className="grid gap-4 text-sm">
      <section className="grid gap-1">
        <h3 className="font-semibold">Package</h3>
        <p>
          {pkg?.name ?? selection.package_key} · {pkg ? money(pkg.base_price_cents) : null}
        </p>
        {included.length > 0 ? (
          <ul className="text-muted-foreground">
            {included.map((l) => (
              <li key={l.item_key}>✓ Included: {l.quantity} × {l.name}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {selection.requirements.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="font-semibold">Required gear</h3>
          <ul className="grid gap-1">
            {selection.requirements.map((r) => (
              <li key={r.gear_key}>
                {r.required_quantity} × {offer.gear[r.gear_key]?.name ?? r.gear_key} required
                {r.included_quantity > 0 ? ` (${r.included_quantity} included, ${r.required_extra_quantity} extra)` : ""}
                <ul className="text-muted-foreground">
                  {r.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="grid gap-1">
        <h3 className="font-semibold">Answers</h3>
        <dl className="grid gap-1">
          {offer.questions.map((q) => (
            <div key={q.key} className="grid gap-0.5 sm:grid-cols-[1fr_auto] sm:gap-3">
              <dt className="text-muted-foreground">{q.prompt}</dt>
              <dd>{q.key in selection.logistics_answers ? answerLabel(offer, q.key, selection.logistics_answers[q.key]) : "—"}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="grid gap-1">
        <h3 className="font-semibold">Total</h3>
        <ul className="grid gap-1">
          {charged.map((l) => (
            <li key={`${l.source}-${l.item_key}`} className="flex justify-between gap-2">
              <span>
                {l.source === "package" ? `${l.name} package` : `${l.quantity} × ${l.name}`}
                {l.source === "required" ? <span className="text-muted-foreground"> (required)</span> : null}
              </span>
              <span className="tabular-nums">{money(l.line_total_cents)}</span>
            </li>
          ))}
          <li className="flex justify-between gap-2 border-t pt-1"><span>Subtotal</span><span className="tabular-nums">{money(selection.subtotal_cents)}</span></li>
          {selection.tax_breakdown.filter((t) => t.amount_cents > 0).map((t) => (
            <li key={t.code} className="flex justify-between gap-2 text-muted-foreground"><span>{t.label}</span><span className="tabular-nums">{money(t.amount_cents)}</span></li>
          ))}
          <li className="flex justify-between gap-2 border-t pt-1 text-base font-semibold"><span>Total</span><span className="tabular-nums">{money(selection.total_cents)}</span></li>
        </ul>
      </section>
    </div>
  );
}
