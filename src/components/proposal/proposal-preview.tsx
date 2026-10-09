"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Camera, Check, ChevronDown, Minus, Plus } from "lucide-react";
import { BrandLogo } from "@/components/app/brand-logo";
import { Button } from "@/components/ui/button";
import { priceSelection, recommendedSelection, type AnswerValue, type OfferSnapshot, type PricedSelection, type PricingResult, type ProposalSelectionState } from "@/lib/pricing";
import { brandStyle } from "@/lib/branding/colors";
import { shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { leadMediaIndex, packageLeadMedia } from "@/lib/proposals/media";
import { cn } from "@/lib/utils";
import { GearPhoto, ProposalMediaProvider, useOpenGallery } from "./gear-media";
import { PriceSummaryCard } from "./price-summary";

export type { ProposalSelectionState } from "@/lib/pricing";

type Logo = { url: string; needsDarkBackground: boolean } | null;
type EventInfo = { title: string; event_date: string; venue_name: string | null };

type ViewProps = {
  offer: OfferSnapshot;
  /** The proposal's media route (see lib/proposals/media). */
  mediaBase: string;
  /** The logo frozen into this offer (signed URL), if any. */
  logo?: Logo;
  event: EventInfo;
  selection: ProposalSelectionState;
  onChange: (next: ProposalSelectionState) => void;
  /** Disables every choice (expired, closed or saving before review); photos stay viewable. */
  readOnly?: boolean;
  /** Marks unanswered required questions (after the client tried to continue). */
  showMissing?: boolean;
  /** The client page is a page of its own (h1); the staff preview sits inside one. */
  asPage?: boolean;
  /** A message above the offer (for example "this proposal has expired"). */
  notice?: ReactNode;
  /** Shown inside the price summary (save status, review button, deadline). */
  summaryActions?: ReactNode;
  /** Narrow layouts: a sticky bar with the live total, a save indicator and the review action. */
  totalBar?: { status?: ReactNode; action: ReactNode };
  /** A photo request found the proposal session has ended. */
  onAccessLost?: () => void;
};

/** Live pricing with the shared engine, plus a provisional price while required answers are missing. */
export function usePricing(offer: OfferSnapshot, selection: ProposalSelectionState) {
  const { package_key, addons, answers } = selection;
  const result = useMemo<PricingResult>(() => priceSelection(offer, { package_key, addons, answers }), [offer, package_key, addons, answers]);
  // While required answers are missing, show a provisional price (as if those questions were optional).
  const provisional = useMemo<PricingResult | null>(() => {
    if (result.ok || result.errors.some((e) => e.code !== "answer_missing")) return null;
    return priceSelection({ ...offer, questions: offer.questions.map((q) => ({ ...q, required: false })) }, { package_key, addons, answers });
  }, [offer, result, package_key, addons, answers]);
  const priced: PricedSelection | null = result.ok ? result.selection : provisional?.ok ? provisional.selection : null;
  const missing = result.ok ? [] : result.errors.filter((e) => e.code === "answer_missing").map((e) => e.path.replace("answers.", ""));
  const invalidAnswers = new Map(result.ok ? [] : result.errors.filter((e) => e.code === "answer_invalid").map((e) => [e.path.replace("answers.", ""), e.message]));
  const problems = result.ok ? [] : result.errors.filter((e) => e.code !== "answer_missing" && e.code !== "answer_invalid").map((e) => e.message);
  return { result, priced, provisional: !result.ok && priced !== null, missing, invalidAnswers, problems };
}

/**
 * Client-facing proposal layout, shared by the client page and the staff
 * preview. Prices are computed live with the shared pricing module from the
 * frozen offer, exactly as the server prices a submission. Packages appear
 * in their configured order; photos come from the frozen offer's media.
 */
export function ProposalView(props: ViewProps) {
  const { offer, mediaBase, logo, event, selection, onChange, readOnly, showMissing, asPage, notice, summaryActions, totalBar, onAccessLost } = props;
  const pricing = usePricing(offer, selection);
  const { priced } = pricing;
  const money = (cents: number) => formatCents(cents, offer.currency);
  const brand = offer.branding.brand_colors;
  const style: CSSProperties = brandStyle(brand.primary);
  const H1 = asPage ? "h1" : "h2";
  const H2 = asPage ? "h2" : "h3";
  const pkg = offer.packages.find((p) => p.key === selection.package_key) ?? null;

  const setAddons = (next: Record<string, number>) => onChange({ ...selection, addons: next });
  const setAnswers = (next: Record<string, AnswerValue>) => onChange({ ...selection, answers: next });

  return (
    <ProposalMediaProvider base={mediaBase} offer={offer} onAccessLost={onAccessLost}>
      <div style={style} className="@container/proposal grid gap-8 text-sm">
        <header className="grid gap-3 rounded-2xl p-5 sm:p-8" style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}>
          <div className="flex min-h-6 items-center">
            <BrandLogo logo={logo ?? null} name={offer.branding.display_name} className="max-h-12 max-w-48" fallbackClassName="text-sm font-semibold tracking-wide uppercase opacity-90" />
          </div>
          <p className="text-xs font-medium tracking-wide uppercase opacity-80">{logo ? `Proposal from ${offer.branding.display_name}` : "Your proposal"}</p>
          <H1 className="text-2xl font-semibold text-balance sm:text-3xl">{event.title}</H1>
          <p className="opacity-90">
            {shortDate(event.event_date)}
            {event.venue_name ? ` · ${event.venue_name}` : ""}
          </p>
          {offer.intro ? <p className="mt-1 max-w-prose text-base whitespace-pre-line opacity-90">{offer.intro}</p> : null}
          <ol aria-label="How this works" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-85">
            <li>1. Choose a package</li>
            <li>2. Tell us about your event</li>
            {offer.addons.length > 0 ? <li>3. Add extras</li> : null}
            <li>{offer.addons.length > 0 ? 4 : 3}. Review and submit</li>
          </ol>
        </header>

        {notice}

        <div className="grid min-w-0 gap-8">
          <section aria-labelledby="pkg-heading" className="grid gap-4">
            <div className="grid gap-1">
              <H2 id="pkg-heading" className="text-lg font-semibold">
                Choose your package
              </H2>
              <p className="text-muted-foreground">Each package has one price. Everything listed in a package is included at no extra charge.</p>
            </div>
            <div role="radiogroup" aria-labelledby="pkg-heading" className="grid grid-cols-3 gap-2 pt-2 @md/proposal:gap-3 @4xl/proposal:gap-5 @4xl/proposal:pt-0">
              {offer.packages.map((p) => (
                <PackageCard key={p.key} offer={offer} packageKey={p.key} selected={p.key === selection.package_key} disabled={readOnly} onSelect={() => onChange({ ...selection, package_key: p.key })} headingTag={asPage ? "h3" : "h4"} />
              ))}
            </div>
            <CompareTable offer={offer} selectedKey={selection.package_key} />
          </section>

          <div className="grid items-start gap-8 @4xl/proposal:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="@container/main grid min-w-0 gap-10">
              {pkg ? (
                <section aria-labelledby="included-heading" className="grid gap-4">
                  <div className="grid gap-1">
                    <H2 id="included-heading" className="text-lg font-semibold">
                      What&apos;s included in {pkg.name}
                    </H2>
                    <p className="text-muted-foreground">All of this is part of the {money(pkg.base_price_cents)} package price.</p>
                    {pkg.description ? <p className="@4xl/proposal:hidden">{pkg.description}</p> : null}
                  </div>
                  {pkg.included.length > 0 ? (
                    <ul className="grid grid-cols-2 gap-2.5 @xl/main:gap-4">
                      {pkg.included.map((i) => (
                        <GearCard key={i.gear_key} offer={offer} gearKey={i.gear_key} headingTag={asPage ? "h3" : "h4"}>
                          <p className="font-medium">{i.quantity} included</p>
                        </GearCard>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">This package doesn&apos;t list any equipment.</p>
                  )}
                </section>
              ) : null}

              {offer.questions.length > 0 ? (
                <Questions offer={offer} answers={selection.answers} onAnswers={setAnswers} missing={showMissing ? pricing.missing : []} invalid={pricing.invalidAnswers} disabled={readOnly} headingTag={H2} />
              ) : null}

              {priced && priced.requirements.length > 0 ? <Requirements offer={offer} priced={priced} headingTag={H2} itemTag={asPage ? "h3" : "h4"} /> : null}

              {offer.addons.length > 0 ? (
                <Extras offer={offer} addons={selection.addons} priced={priced} packageKey={selection.package_key} onAddons={setAddons} disabled={readOnly} headingTag={H2} itemTag={asPage ? "h3" : "h4"} />
              ) : null}
            </div>

            <aside aria-label="Price" className="grid gap-3 @4xl/proposal:sticky @4xl/proposal:top-4">
              <PriceSummaryCard id="price-summary" title="Your total" headingLevel={asPage ? 2 : 3} priced={priced} provisional={pricing.provisional} problems={pricing.problems}>
                {summaryActions}
              </PriceSummaryCard>
            </aside>
          </div>
        </div>

        {totalBar ? <TotalBar priced={priced} provisional={pricing.provisional} status={totalBar.status} action={totalBar.action} /> : null}
      </div>
    </ProposalMediaProvider>
  );
}

const VISIBLE_INCLUDED = 5;

function PackageCard({ offer, packageKey, selected, disabled, onSelect, headingTag: Heading }: { offer: OfferSnapshot; packageKey: string; selected: boolean; disabled?: boolean; onSelect: () => void; headingTag: "h3" | "h4" }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const openGallery = useOpenGallery();
  const p = offer.packages.find((x) => x.key === packageKey)!;
  const lead = packageLeadMedia(offer, p.key);
  const items = expanded ? p.included : p.included.slice(0, VISIBLE_INCLUDED);
  const hidden = p.included.length - VISIBLE_INCLUDED;
  return (
    <article
      data-testid="package-card"
      className={cn("relative flex min-w-0 flex-col rounded-xl border-2 bg-card transition-shadow @4xl/proposal:rounded-2xl", selected ? "shadow-lg" : "border-border")}
      style={selected ? { borderColor: "var(--brand)" } : undefined}
    >
      {p.is_popular ? (
        <span className="absolute -top-2.5 left-1/2 z-10 -translate-x-1/2 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold whitespace-nowrap shadow-sm @4xl/proposal:-top-3 @4xl/proposal:left-4 @4xl/proposal:translate-x-0 @4xl/proposal:px-3 @4xl/proposal:py-1 @4xl/proposal:text-xs" style={{ background: "var(--brand)", color: "var(--brand-foreground)" }}>
          Recommended
        </span>
      ) : null}
      <div className="p-1.5 pb-0 @4xl/proposal:p-3 @4xl/proposal:pb-0">
        {lead ? (
          <GearPhoto gearKey={lead.gearKey} sizes="(min-width: 1024px) 360px, 34vw" className="rounded-lg @4xl/proposal:rounded-xl" />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-muted p-1 text-center text-xs text-muted-foreground @4xl/proposal:rounded-xl">No photos</div>
        )}
      </div>
      <div className="grid flex-1 content-start gap-3 p-2 @4xl/proposal:p-4">
        <div className="grid gap-0.5">
          <Heading id={`${id}-name`} className="text-sm leading-tight font-semibold [overflow-wrap:anywhere] @4xl/proposal:text-lg @4xl/proposal:leading-normal">
            {p.name}
          </Heading>
          <p className="text-[0.8125rem] font-semibold tabular-nums [overflow-wrap:anywhere] @lg/proposal:text-base @4xl/proposal:text-2xl">{formatCents(p.base_price_cents, offer.currency)}</p>
        </div>
        {/* The full description and equipment list fit the wide (desktop) cards; narrow screens show them for the selected package below. */}
        {p.description ? <p className="hidden text-muted-foreground @4xl/proposal:block">{p.description}</p> : null}
        <div className="hidden gap-1.5 @4xl/proposal:grid">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Included</p>
          <ul className="grid gap-1" id={`${id}-items`}>
            {items.map((i) => {
              const gear = offer.gear[i.gear_key];
              return (
                <li key={i.gear_key} className="flex items-center gap-2">
                  <Check aria-hidden className="size-4 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium tabular-nums">{i.quantity} ×</span> {gear?.name}
                  </span>
                  {gear && gear.media.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => openGallery(i.gear_key, leadMediaIndex(gear.media))}
                      aria-label={`Photos of ${gear.name}`}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Camera aria-hidden className="size-4" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hidden > 0 ? (
            <button type="button" aria-expanded={expanded} aria-controls={`${id}-items`} onClick={() => setExpanded((e) => !e)} className="inline-flex min-h-9 items-center gap-1 justify-self-start rounded-md text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
              {expanded ? "Show fewer" : `Show ${hidden} more`}
              <ChevronDown aria-hidden className={cn("size-4 transition-transform", expanded && "rotate-180")} />
            </button>
          ) : null}
        </div>
      </div>
      <label
        className={cn(
          "m-1.5 mt-0 flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-lg border-2 px-1 text-xs font-semibold transition-colors has-[:disabled]:cursor-not-allowed has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/60 @4xl/proposal:m-4 @4xl/proposal:mt-0 @4xl/proposal:gap-2 @4xl/proposal:rounded-xl @4xl/proposal:px-4 @4xl/proposal:text-sm",
          !selected && "hover:bg-muted",
        )}
        style={selected ? { background: "var(--brand)", color: "var(--brand-foreground)", borderColor: "var(--brand)" } : undefined}
      >
        <input type="radio" name="package" className="sr-only" checked={selected} disabled={disabled} onChange={onSelect} aria-labelledby={`${id}-name ${id}-cta`} />
        {selected ? <Check aria-hidden className="size-3.5 shrink-0 @4xl/proposal:size-4" /> : null}
        <span id={`${id}-cta`}>
          {selected ? (
            "Selected"
          ) : (
            <>
              Choose<span className="hidden @4xl/proposal:inline"> {p.name}</span>
            </>
          )}
        </span>
      </label>
    </article>
  );
}

/** Which equipment each package includes, side by side (a table, so it reads well on any screen). */
function CompareTable({ offer, selectedKey }: { offer: OfferSnapshot; selectedKey: string }) {
  const keys: string[] = [];
  for (const p of offer.packages) for (const i of p.included) if (!keys.includes(i.gear_key)) keys.push(i.gear_key);
  if (keys.length === 0) return null;
  return (
    <details className="group/compare rounded-2xl border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-2xl px-4 font-medium outline-none select-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open/compare:rotate-0" />
        Compare packages side by side
      </summary>
      <div className="border-t p-2 sm:p-4">
        <table className="w-full table-fixed border-collapse text-xs sm:text-sm">
          <caption className="sr-only">Equipment included in each package</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[40%] p-2 text-left font-medium text-muted-foreground">Equipment</th>
              {offer.packages.map((p) => (
                <th key={p.key} scope="col" className={cn("p-2 text-center font-semibold break-words", p.key === selectedKey && "bg-muted")}>
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <th scope="row" className="p-2 text-left font-medium">Price</th>
              {offer.packages.map((p) => (
                <td key={p.key} className={cn("p-2 text-center tabular-nums break-words", p.key === selectedKey && "bg-muted")}>
                  {formatCents(p.base_price_cents, offer.currency)}
                </td>
              ))}
            </tr>
            {keys.map((k) => (
              <tr key={k} className="border-t">
                <th scope="row" className="p-2 text-left font-normal break-words">{offer.gear[k]?.name}</th>
                {offer.packages.map((p) => {
                  const q = p.included.find((i) => i.gear_key === k)?.quantity;
                  return (
                    <td key={p.key} className={cn("p-2 text-center tabular-nums", p.key === selectedKey && "bg-muted")}>
                      {q ? q : <span aria-label="Not included" className="text-muted-foreground">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** A gear item with a large photo, its name, description and whatever the caller adds (quantity, price). */
function GearCard({ offer, gearKey, headingTag: Heading, children, footer }: { offer: OfferSnapshot; gearKey: string; headingTag: "h3" | "h4"; children?: ReactNode; footer?: ReactNode }) {
  const gear = offer.gear[gearKey];
  // Cards size themselves to their own width: compact two-up on phones, roomier where there is space.
  return (
    <li className="@container/card flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card @xs/card:rounded-2xl">
      <div className="p-1.5 pb-0 @xs/card:p-2 @xs/card:pb-0">
        <GearPhoto gearKey={gearKey} sizes="(min-width: 640px) 400px, 50vw" className="rounded-lg @xs/card:rounded-xl" />
      </div>
      <div className="grid flex-1 content-start gap-1 p-2.5 text-xs @xs/card:gap-1.5 @xs/card:p-4 @xs/card:text-sm">
        <Heading className="text-sm leading-snug font-semibold [overflow-wrap:anywhere] @xs/card:text-base">{gear?.name}</Heading>
        {children}
        {gear?.description ? <Description text={gear.description} /> : null}
      </div>
      {footer}
    </li>
  );
}

/** A description clamped to a few lines on small cards, with a button to read all of it. */
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    check();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="grid justify-items-start gap-0.5">
      <p ref={ref} className={cn("text-muted-foreground [overflow-wrap:anywhere]", !expanded && "line-clamp-3 @xs/card:line-clamp-none")}>
        {text}
      </p>
      {overflowing || expanded ? (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} className="min-h-8 rounded-md font-medium underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function Questions({
  offer,
  answers,
  onAnswers,
  missing,
  invalid,
  disabled,
  headingTag: Heading,
}: {
  offer: OfferSnapshot;
  answers: Record<string, AnswerValue>;
  onAnswers: (next: Record<string, AnswerValue>) => void;
  missing: string[];
  invalid: Map<string, string>;
  disabled?: boolean;
  headingTag: "h2" | "h3";
}) {
  const option = "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 has-[:checked]:border-[var(--brand)] has-[:checked]:bg-muted/60 has-[:disabled]:cursor-not-allowed has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50";
  return (
    <section aria-labelledby="q-heading" className="grid gap-4">
      <div className="grid gap-1">
        <Heading id="q-heading" className="text-lg font-semibold">
          About your event
        </Heading>
        <p className="text-muted-foreground">Your answers help plan the right equipment. Some answers add equipment your event needs; it&apos;s shown below with the reason.</p>
      </div>
      {offer.questions.map((q) => {
        const error = missing.includes(q.key) ? "Please answer this question." : invalid.get(q.key);
        const errorId = `q-${q.key}-error`;
        return (
          <fieldset key={q.key} id={`q-${q.key}`} disabled={disabled} aria-describedby={error ? errorId : undefined} className={cn("m-0 grid min-w-0 scroll-mt-4 gap-2 rounded-2xl border p-4", error && "border-destructive")}>
            <legend className="float-left mb-1 flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm font-medium">
              <span>{q.prompt}</span>
              <span className={cn("text-xs font-normal", q.required ? "text-foreground" : "text-muted-foreground")}>{q.required ? "Required" : "Optional"}</span>
            </legend>
            {q.answer_type === "boolean" ? (
              <div className="grid grid-cols-2 gap-2">
                {([["Yes", true], ["No", false]] as const).map(([label, value]) => (
                  <label key={label} className={option}>
                    <input type="radio" name={`q-${q.key}`} checked={answers[q.key] === value} onChange={() => onAnswers({ ...answers, [q.key]: value })} className="size-4 accent-[var(--brand)]" />
                    {label}
                  </label>
                ))}
              </div>
            ) : q.answer_type === "single_choice" ? (
              <div className="grid gap-2 @md/main:grid-cols-2">
                {q.options.map((o) => (
                  <label key={o.value} className={option}>
                    <input type="radio" name={`q-${q.key}`} checked={answers[q.key] === o.value} onChange={() => onAnswers({ ...answers, [q.key]: o.value })} className="size-4 accent-[var(--brand)]" />
                    {o.label}
                  </label>
                ))}
              </div>
            ) : q.answer_type === "multi_choice" ? (
              <div className="grid gap-2 @md/main:grid-cols-2">
                {q.options.map((o) => {
                  const current = (answers[q.key] as string[] | undefined) ?? [];
                  return (
                    <label key={o.value} className={option}>
                      <input
                        type="checkbox"
                        checked={current.includes(o.value)}
                        onChange={(e) => onAnswers({ ...answers, [q.key]: e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value) })}
                        className="size-4 accent-[var(--brand)]"
                      />
                      {o.label}
                    </label>
                  );
                })}
              </div>
            ) : (
              <textarea
                className="min-h-20 w-full rounded-xl border bg-transparent p-3 text-base sm:text-sm"
                maxLength={2000}
                value={(answers[q.key] as string | undefined) ?? ""}
                onChange={(e) => onAnswers({ ...answers, [q.key]: e.target.value })}
                aria-label={q.prompt}
                aria-invalid={error ? true : undefined}
              />
            )}
            {error ? (
              <p id={errorId} className="text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </section>
  );
}

/** Equipment the answers require: how much, what the package already covers, what it adds, and why. */
function Requirements({ offer, priced, headingTag: Heading, itemTag }: { offer: OfferSnapshot; priced: PricedSelection; headingTag: "h2" | "h3"; itemTag: "h3" | "h4" }) {
  const money = (cents: number) => formatCents(cents, offer.currency);
  const addonKeys = new Set(offer.addons.map((a) => a.gear_key));
  return (
    <section aria-labelledby="req-heading" className="grid gap-4">
      <div className="grid gap-1">
        <Heading id="req-heading" className="text-lg font-semibold">
          Required for your event
        </Heading>
        <p className="text-muted-foreground">Based on your answers, this equipment is needed to run your event properly.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2.5 @xl/main:gap-4">
        {priced.requirements.map((r) => {
          const gear = offer.gear[r.gear_key];
          const extra = r.required_extra_quantity;
          return (
            <GearCard key={r.gear_key} offer={offer} gearKey={r.gear_key} headingTag={itemTag}>
              <p className="font-medium">
                {r.required_quantity} needed
                {r.included_quantity > 0 ? ` · ${Math.min(r.included_quantity, r.required_quantity)} covered by your package` : ""}
              </p>
              <p className={extra > 0 ? "text-amber-800 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-400"}>
                {extra === 0
                  ? "Already included in your package. Nothing extra to pay."
                  : addonKeys.has(r.gear_key)
                    ? `At least ${extra} added at ${money(gear.unit_price_cents)} per ${gear.unit_label}. You can add more under Optional extras.`
                    : `${extra} added at ${money(gear.unit_price_cents)} per ${gear.unit_label}.`}
              </p>
              <ul className="grid list-disc gap-0.5 pl-4 text-muted-foreground @xs/card:pl-5">
                {r.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </GearCard>
          );
        })}
      </ul>
    </section>
  );
}

function Extras({
  offer,
  addons,
  priced,
  packageKey,
  onAddons,
  disabled,
  headingTag: Heading,
  itemTag,
}: {
  offer: OfferSnapshot;
  addons: Record<string, number>;
  priced: PricedSelection | null;
  packageKey: string;
  onAddons: (next: Record<string, number>) => void;
  disabled?: boolean;
  headingTag: "h2" | "h3";
  itemTag: "h3" | "h4";
}) {
  const money = (cents: number) => formatCents(cents, offer.currency);
  const pkg = offer.packages.find((p) => p.key === packageKey);
  const requirement = new Map((priced?.requirements ?? []).map((r) => [r.gear_key, r]));
  const lines = new Map((priced?.lines ?? []).filter((l) => l.source === "optional" || l.source === "required").map((l) => [l.item_key, l]));
  return (
    <section aria-labelledby="addon-heading" className="grid gap-4">
      <div className="grid gap-1">
        <Heading id="addon-heading" className="text-lg font-semibold">
          Optional extras
        </Heading>
        <p className="text-muted-foreground">Add anything you&apos;d like on top of your package. Prices are per unit.</p>
      </div>
      <ul className="grid grid-cols-2 gap-2.5 @xl/main:gap-4">
        {offer.addons.map((a) => {
          const gear = offer.gear[a.gear_key];
          const req = requirement.get(a.gear_key);
          const minimum = req?.required_extra_quantity ?? 0;
          // The quantity the price uses: the larger of the client's choice and what answers require.
          const shown = Math.max(addons[a.gear_key] ?? 0, minimum);
          const ceiling = Math.max(a.max_quantity, minimum);
          const includedQty = pkg?.included.find((i) => i.gear_key === a.gear_key)?.quantity ?? 0;
          const line = lines.get(a.gear_key);
          return (
            <GearCard
              key={a.gear_key}
              offer={offer}
              gearKey={a.gear_key}
              headingTag={itemTag}
              footer={
                <div className="grid gap-1.5 border-t p-2 @xs/card:flex @xs/card:flex-wrap @xs/card:items-center @xs/card:justify-between @xs/card:gap-3 @xs/card:p-3">
                  <div className="flex items-center justify-between gap-0.5 @xs/card:justify-start @xs/card:gap-1" role="group" aria-label={`${gear.name} quantity`}>
                    <Button type="button" size="icon-lg" variant="outline" className="size-11" aria-label={`Fewer ${gear.name}`} disabled={disabled || shown <= minimum || shown === 0} onClick={() => onAddons({ ...addons, [a.gear_key]: Math.max(0, shown - 1) })}>
                      <Minus aria-hidden />
                    </Button>
                    <span className="w-7 text-center text-base font-semibold tabular-nums @xs/card:w-8" aria-live="polite">
                      {shown}
                    </span>
                    <Button type="button" size="icon-lg" variant="outline" className="size-11" aria-label={`More ${gear.name}`} disabled={disabled || shown >= ceiling} onClick={() => onAddons({ ...addons, [a.gear_key]: shown + 1 })}>
                      <Plus aria-hidden />
                    </Button>
                  </div>
                  <span className="text-center text-xs text-muted-foreground tabular-nums @xs/card:text-sm">
                    {line && shown > 0 ? <span className="font-medium text-foreground">Adds {money(line.line_total_cents)}</span> : shown > 0 ? "Choose a package to see the price" : `Up to ${a.max_quantity}`}
                  </span>
                </div>
              }
            >
              <p className="font-medium">
                {money(gear.unit_price_cents)} per {gear.unit_label}
              </p>
              {includedQty > 0 ? (
                <p className="rounded-lg bg-muted px-2 py-1.5 @xs/card:px-3 @xs/card:py-2">
                  Your package already includes {includedQty}. Extras here are in addition.
                </p>
              ) : null}
              {minimum > 0 ? (
                <div className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-amber-900 @xs/card:px-3 @xs/card:py-2 dark:text-amber-200">
                  <p className="font-medium">Required for your event: at least {minimum}.</p>
                  <ul className="grid list-disc gap-0.5 pl-4 @xs/card:pl-5">
                    {req!.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </GearCard>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Narrow screens: one bar with the live total and the review action. It is
 * sticky inside the proposal, so it follows the page (or the staff preview's
 * own scroll area), and at the end it settles below the last controls instead
 * of covering them. It is hidden while the on-screen keyboard is open (a text
 * field has focus and the visual viewport has shrunk) and returns as soon as
 * the keyboard closes. Wide layouts have the sticky summary instead.
 */
function TotalBar({ priced, provisional, status, action }: { priced: PricedSelection | null; provisional: boolean; status?: ReactNode; action: ReactNode }) {
  const [typing, setTyping] = useState(false);
  const [keyboard, setKeyboard] = useState(false);

  useEffect(() => {
    const isText = (el: EventTarget | null) =>
      el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit", "range", "color", "file"].includes(el.type));
    const onIn = (e: FocusEvent) => setTyping(isText(e.target));
    const onOut = () => setTyping(false);
    const viewport = window.visualViewport;
    // The keyboard shrinks the visual viewport; without the API, assume a focused field means a keyboard.
    const measure = () => setKeyboard(viewport ? viewport.height < window.innerHeight * 0.8 : true);
    measure();
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    viewport?.addEventListener("resize", measure);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      viewport?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const hidden = typing && keyboard;
  return (
    <div
      data-testid="sticky-total"
      className={cn(
        "sticky bottom-0 z-30 -mt-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-opacity @4xl/proposal:hidden",
        hidden && "invisible opacity-0",
      )}
    >
      <div className="flex items-center gap-3 rounded-2xl border bg-background/95 py-2 pr-2 pl-4 shadow-[0_-2px_16px_rgba(0,0,0,0.12)] backdrop-blur">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-xs text-muted-foreground">{priced ? (provisional ? "Estimated total incl. tax" : "Total incl. tax") : "Total unavailable"}</p>
          <p className="text-base leading-tight font-semibold tabular-nums">{priced ? formatCents(priced.total_cents, priced.currency) : "Check your choices"}</p>
          {status ? <div className="text-xs">{status}</div> : null}
        </div>
        {action}
      </div>
    </div>
  );
}

/**
 * Staff preview: local, unsaved selection state; nothing is sent or stored.
 * `contained` (the builder and sent view) gives it its own scroll area on
 * large screens, so a long proposal doesn't stretch the page and its total
 * bar stays inside the preview; phones scroll the page normally.
 */
export function ProposalPreview({ offer, mediaBase, logo, event, contained }: { offer: OfferSnapshot; mediaBase: string; logo?: Logo; event: EventInfo; contained?: boolean }) {
  const [selection, setSelection] = useState(() => recommendedSelection(offer));
  const reviewButton = (
    <Button type="button" disabled title="Staff preview: clients submit from their own link." className="min-h-11 shrink-0 px-4">
      Review proposal
    </Button>
  );
  const view = (
    <ProposalView
      offer={offer}
      mediaBase={mediaBase}
      logo={logo}
      event={event}
      selection={selection}
      onChange={setSelection}
      totalBar={{ status: <span className="text-muted-foreground">Staff preview: not saved</span>, action: reviewButton }}
      summaryActions={
        <div className="grid gap-2">
          <p className="text-muted-foreground">This offer is valid for {offer.expiry_days} days after it is sent.</p>
          {reviewButton}
          <p className="text-xs text-muted-foreground">Staff preview: choices here are not saved or sent.</p>
        </div>
      }
    />
  );
  if (!contained) return view;
  return (
    <div data-testid="preview-viewport" role="region" tabIndex={0} aria-label="Client preview (scrolls separately)" className="lg:max-h-[calc(100dvh-11rem)] lg:min-h-96 lg:overflow-y-auto lg:overscroll-contain lg:rounded-xl lg:border lg:p-3 lg:outline-none lg:focus-visible:ring-3 lg:focus-visible:ring-ring/50">
      {view}
    </div>
  );
}
