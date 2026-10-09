import type { OfferSnapshot, PricedSelection } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { PriceLines } from "./price-summary";

function answerLabel(offer: OfferSnapshot, key: string, value: unknown): string {
  const question = offer.questions.find((q) => q.key === key);
  const label = (v: unknown) => question?.options.find((o) => o.value === v)?.label ?? String(v);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(label).join(", ") : "None";
  return label(value);
}

/**
 * A priced selection, read-only: package and included equipment, equipment
 * the answers require, extras, answers and the price. Used for the client's
 * review step, the submitted proposal and the staff's view of a submission.
 */
export function SelectionSummary({ offer, selection, headingLevel = 3 }: { offer: OfferSnapshot; selection: PricedSelection; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const money = (cents: number) => formatCents(cents, selection.currency);
  const pkg = offer.packages.find((p) => p.key === selection.package_key);
  const included = selection.lines.filter((l) => l.source === "included");
  const extras = selection.lines.filter((l) => l.source === "optional");
  return (
    <div className="grid gap-5 text-sm">
      <section className="grid gap-1">
        <Heading className="font-semibold">Package</Heading>
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
          <Heading className="font-semibold">Required gear</Heading>
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
      {extras.length > 0 ? (
        <section className="grid gap-1">
          <Heading className="font-semibold">Extras</Heading>
          <ul>
            {extras.map((l) => (
              <li key={l.item_key}>
                {l.quantity} × {l.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="grid gap-1">
        <Heading className="font-semibold">Answers</Heading>
        <dl className="grid gap-2">
          {offer.questions.map((q) => (
            <div key={q.key} className="grid gap-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
              <dt className="text-muted-foreground">{q.prompt}</dt>
              <dd className="break-words whitespace-pre-line">{q.key in selection.logistics_answers ? answerLabel(offer, q.key, selection.logistics_answers[q.key]) : "—"}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="grid gap-2">
        <Heading className="font-semibold">Total</Heading>
        <PriceLines priced={selection} />
      </section>
    </div>
  );
}
