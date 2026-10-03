"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { priceSelection, recommendedSelection, type AnswerValue, type OfferSnapshot, type PricingResult, type ProposalSelectionState } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

export type { ProposalSelectionState } from "@/lib/pricing";

type ViewProps = {
  offer: OfferSnapshot;
  mediaUrls: Record<string, string>;
  event: { title: string; event_date: string; venue_name: string | null };
  selection: ProposalSelectionState;
  onChange: (next: ProposalSelectionState) => void;
  /** Disables every control (expired offers). */
  readOnly?: boolean;
  /** Rendered under the total (save status, submit button, deadline). */
  footer?: ReactNode;
};

/**
 * Client-facing proposal layout, shared by the staff preview and the client
 * page. Prices are computed live with the shared pricing module from the
 * frozen-offer shape, exactly as the server prices a submission. Required
 * gear cannot be reduced below its required quantity.
 */
export function ProposalView({ offer, mediaUrls, event, selection, onChange, readOnly, footer }: ViewProps) {
  const packageKey = selection.package_key;
  const addons = selection.addons;
  const answers = selection.answers;
  const setPackageKey = (key: string) => onChange({ ...selection, package_key: key });
  const setAddons = (next: Record<string, number>) => onChange({ ...selection, addons: next });
  const setAnswers = (next: Record<string, AnswerValue>) => onChange({ ...selection, answers: next });

  const input = { package_key: packageKey, addons, answers };
  const result = useMemo(() => priceSelection(offer, input), [offer, packageKey, addons, answers]); // eslint-disable-line react-hooks/exhaustive-deps
  // While required answers are missing, show a provisional price (as if those questions were optional).
  const provisional = useMemo<PricingResult | null>(() => {
    if (result.ok || result.errors.some((e) => e.code !== "answer_missing")) return null;
    return priceSelection({ ...offer, questions: offer.questions.map((q) => ({ ...q, required: false })) }, input);
  }, [offer, result, packageKey, addons, answers]); // eslint-disable-line react-hooks/exhaustive-deps
  const priced = result.ok ? result.selection : provisional?.ok ? provisional.selection : null;
  const missing = result.ok ? [] : result.errors.filter((e) => e.code === "answer_missing").map((e) => e.path.replace("answers.", ""));
  const otherErrors = result.ok ? [] : result.errors.filter((e) => e.code !== "answer_missing");

  const requiredExtra = new Map((priced?.requirements ?? []).map((r) => [r.gear_key, r.required_extra_quantity]));
  const money = (cents: number) => formatCents(cents, offer.currency);
  const brand = offer.branding.brand_colors;
  const style = { "--brand": brand.primary ?? "#111827", "--brand-accent": brand.accent ?? brand.primary ?? "#111827" } as CSSProperties;

  const thumbnail = (gearKey: string) => {
    const media = offer.gear[gearKey]?.media[0];
    const url = media ? mediaUrls[media.storage_path] : undefined;
    if (!media || !url) return null;
    return media.kind === "image" ? (
      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
      <img src={url} alt={media.alt_text} className="size-16 shrink-0 rounded-lg object-cover" />
    ) : (
      <video src={url} muted playsInline preload="metadata" aria-label={media.alt_text} className="size-16 shrink-0 rounded-lg object-cover" />
    );
  };

  return (
    <div style={style} className="grid gap-6 text-sm">
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-6 border-0 p-0">
      <header className="grid gap-2 rounded-2xl p-5 text-white" style={{ background: "var(--brand)" }}>
        <p className="text-xs tracking-wide uppercase opacity-80">{offer.branding.display_name}</p>
        <h2 className="text-xl font-semibold">{event.title}</h2>
        <p className="opacity-90">
          {event.event_date}
          {event.venue_name ? ` · ${event.venue_name}` : ""}
        </p>
        {offer.intro ? <p className="mt-2 max-w-prose whitespace-pre-line opacity-90">{offer.intro}</p> : null}
      </header>

      <section aria-labelledby="pkg-heading" className="grid gap-3">
        <h3 id="pkg-heading" className="text-base font-semibold">Choose your package</h3>
        <div className="grid gap-3 md:grid-cols-3">
          {offer.packages.map((p) => {
            const selected = p.key === packageKey;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setPackageKey(p.key)}
                className={cn("grid content-start gap-2 rounded-2xl border-2 p-4 text-left transition-colors", selected ? "border-[var(--brand-accent)]" : "border-border hover:bg-muted")}
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {p.is_popular ? <Badge style={{ background: "var(--brand-accent)" }}>Most popular</Badge> : null}
                </span>
                <span className="text-lg font-semibold">{money(p.base_price_cents)}</span>
                {p.description ? <span className="text-muted-foreground">{p.description}</span> : null}
                <ul className="grid gap-1">
                  {p.included.map((i) => (
                    <li key={i.gear_key}>✓ {i.quantity} × {offer.gear[i.gear_key]?.name}</li>
                  ))}
                </ul>
                {p.included.some((i) => offer.gear[i.gear_key]?.media.length) ? (
                  <span className="flex flex-wrap gap-2">{p.included.map((i) => <span key={i.gear_key}>{thumbnail(i.gear_key)}</span>)}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {offer.questions.length > 0 ? (
        <section aria-labelledby="q-heading" className="grid gap-4">
          <h3 id="q-heading" className="text-base font-semibold">About your event</h3>
          {offer.questions.map((q) => (
            <fieldset key={q.key} className={cn("grid gap-2 rounded-xl border p-3", missing.includes(q.key) && "border-amber-500")}>
              <legend className="px-1 font-medium">
                {q.prompt} {q.required ? null : <span className="font-normal text-muted-foreground">(optional)</span>}
              </legend>
              {q.answer_type === "boolean" ? (
                <div className="flex gap-4">
                  {[["Yes", true], ["No", false]].map(([label, value]) => (
                    <label key={String(value)} className="flex items-center gap-2">
                      <input type="radio" name={`q-${q.key}`} checked={answers[q.key] === value} onChange={() => setAnswers({ ...answers, [q.key]: value as boolean })} className="size-4" />
                      {label as string}
                    </label>
                  ))}
                </div>
              ) : q.answer_type === "single_choice" ? (
                q.options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2">
                    <input type="radio" name={`q-${q.key}`} checked={answers[q.key] === o.value} onChange={() => setAnswers({ ...answers, [q.key]: o.value })} className="size-4" />
                    {o.label}
                  </label>
                ))
              ) : q.answer_type === "multi_choice" ? (
                q.options.map((o) => {
                  const current = (answers[q.key] as string[] | undefined) ?? [];
                  return (
                    <label key={o.value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={current.includes(o.value)}
                        onChange={(e) =>
                          setAnswers({ ...answers, [q.key]: e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value) })
                        }
                        className="size-4"
                      />
                      {o.label}
                    </label>
                  );
                })
              ) : (
                <textarea
                  className="min-h-16 rounded-lg border bg-transparent p-2"
                  maxLength={2000}
                  value={(answers[q.key] as string | undefined) ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}
                  aria-label={q.prompt}
                />
              )}
            </fieldset>
          ))}
        </section>
      ) : null}

      {priced && priced.requirements.some((r) => r.required_extra_quantity > 0) ? (
        <section aria-labelledby="req-heading" className="grid gap-2 rounded-xl border p-3">
          <h3 id="req-heading" className="text-base font-semibold">Required for your event</h3>
          <p className="text-muted-foreground">Based on your answers, this equipment is needed to run your event properly.</p>
          <ul className="grid gap-2">
            {priced.requirements
              .filter((r) => r.required_extra_quantity > 0)
              .map((r) => (
                <li key={r.gear_key}>
                  <span className="font-medium">
                    {r.required_extra_quantity} × {offer.gear[r.gear_key]?.name}
                  </span>
                  {r.included_quantity > 0 ? ` (plus ${r.included_quantity} included in your package)` : null}
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

      {offer.addons.length > 0 ? (
        <section aria-labelledby="addon-heading" className="grid gap-3">
          <h3 id="addon-heading" className="text-base font-semibold">Optional extras</h3>
          <ul className="grid gap-2">
            {offer.addons.map((a) => {
              const gear = offer.gear[a.gear_key];
              const minimum = requiredExtra.get(a.gear_key) ?? 0;
              const shown = Math.max(addons[a.gear_key] ?? 0, minimum);
              return (
                <li key={a.gear_key} className="flex items-center gap-3 rounded-xl border p-3">
                  {thumbnail(a.gear_key)}
                  <div className="grid flex-1 gap-0.5">
                    <span className="font-medium">{gear.name}</span>
                    <span className="text-muted-foreground">
                      {money(gear.unit_price_cents)} per {gear.unit_label}
                      {minimum > 0 ? ` · at least ${minimum} required` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2" role="group" aria-label={`${gear.name} quantity`}>
                    <Button type="button" size="icon-sm" variant="outline" aria-label={`Fewer ${gear.name}`} disabled={shown <= minimum || shown === 0}
                      onClick={() => setAddons({ ...addons, [a.gear_key]: Math.max(0, shown - 1) })}>−</Button>
                    <span className="w-6 text-center tabular-nums" aria-live="polite">{shown}</span>
                    <Button type="button" size="icon-sm" variant="outline" aria-label={`More ${gear.name}`} disabled={shown >= Math.max(a.max_quantity, minimum)}
                      onClick={() => setAddons({ ...addons, [a.gear_key]: shown + 1 })}>+</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="total-heading" className="grid gap-2 rounded-2xl border-2 p-4" style={{ borderColor: "var(--brand)" }}>
        <h3 id="total-heading" className="text-base font-semibold">Your total</h3>
        {otherErrors.length > 0 ? (
          <ul role="alert" className="text-destructive">
            {otherErrors.map((e) => <li key={e.path}>{e.message}</li>)}
          </ul>
        ) : null}
        {priced ? (
          <>
            <ul className="grid gap-1">
              {priced.lines.filter((l) => l.line_total_cents > 0).map((l) => (
                <li key={`${l.source}-${l.item_key}`} className="flex justify-between gap-2">
                  <span>
                    {l.source === "package" ? `${l.name} package` : `${l.quantity} × ${l.name}`}
                    {l.source === "required" ? <span className="text-muted-foreground"> (required)</span> : null}
                  </span>
                  <span className="tabular-nums">{money(l.line_total_cents)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-2 border-t pt-1"><span>Subtotal</span><span className="tabular-nums">{money(priced.subtotal_cents)}</span></li>
              {priced.tax_breakdown.filter((t) => t.amount_cents > 0).map((t) => (
                <li key={t.code} className="flex justify-between gap-2 text-muted-foreground">
                  <span>{t.label} ({(t.rate_ppm / 10_000).toLocaleString("en-CA", { maximumFractionDigits: 4 })}%)</span>
                  <span className="tabular-nums">{money(t.amount_cents)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-2 border-t pt-1 text-base font-semibold"><span>Total</span><span className="tabular-nums">{money(priced.total_cents)}</span></li>
            </ul>
            {missing.length > 0 ? (
              <p className="text-amber-700 dark:text-amber-400">Provisional: answer the highlighted required questions to confirm your total.</p>
            ) : null}
          </>
        ) : null}
      </section>
      </fieldset>
      {footer}
    </div>
  );
}

/** Staff preview: local, unsaved selection state; nothing is sent or stored. */
export function ProposalPreview({ offer, mediaUrls, event }: { offer: OfferSnapshot; mediaUrls: Record<string, string>; event: ViewProps["event"] }) {
  const [selection, setSelection] = useState(() => recommendedSelection(offer));
  return (
    <ProposalView
      offer={offer}
      mediaUrls={mediaUrls}
      event={event}
      selection={selection}
      onChange={setSelection}
      footer={
        <div className="grid gap-2">
          <p className="text-muted-foreground">This offer is valid for {offer.expiry_days} days after it is sent.</p>
          <Button type="button" disabled title="Staff preview: clients submit from their own link.">
            Submit for DJ review
          </Button>
        </div>
      }
    />
  );
}
