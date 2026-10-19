"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoicePicker } from "@/components/app/choice-picker";
import { useDraftEditorState } from "@/components/app/draft-version";
import { selectClass, TextAreaField, TextField } from "@/components/app/fields";
import { GearThumb } from "@/components/app/gear-thumb";
import { TaxSetupLink } from "@/components/app/tax-setup-link";
import { ProposalPreview } from "@/components/proposal/proposal-preview";
import { perUnitText } from "@/lib/catalog/quantity";
import type { GearChoice } from "@/lib/catalog/gear-choices.server";
import { centsToInputValue, formatCents, parseMoneyToCents } from "@/lib/money";
import { basisPointsToInputValue, minimumSelectionSubtotal, readDiscount, type DiscountKind, type DraftDiscount } from "@/lib/pricing/discount";
import { cn } from "@/lib/utils";
import { previewDraftOffer, type DraftPreview } from "../actions";

// ---------------------------------------------------------------------------
// The draft as the editor currently has it, shared with the live preview
// ---------------------------------------------------------------------------

/** The offer input the editor's fields describe, as saveDraft would store it (null while a field is invalid). */
export type DraftOfferInput = {
  template_id: string | null;
  intro: string | null;
  expiry_days: number;
  packages: { package_id: string; is_popular: boolean }[];
  addons: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[];
  question_ids: string[];
  price_overrides?: PriceOverride[];
  /** One discount on the whole proposal; absent when there is none. */
  discount?: DraftDiscount;
};

/** This proposal's price for a gear item, or a package's base price (by stable id). */
export type PriceOverride = { gear_item_id: string; unit_price_cents: number } | { package_id: string; unit_price_cents: number };

type Shared = { offer: DraftOfferInput | null; problem: string | null };
/**
 * The draft (from the editor) and, from the preview, the offer's lowest
 * possible subtotal: the largest fixed discount it allows (null until known).
 */
const DraftOfferContext = createContext<{ value: Shared; set: (v: Shared) => void; minimum: number | null; setMinimum: (cents: number | null) => void } | null>(null);

export function DraftOfferProvider({ children }: { children: ReactNode }) {
  const [value, set] = useState<Shared>({ offer: null, problem: null });
  const [minimum, setMinimum] = useState<number | null>(null);
  const context = useMemo(() => ({ value, set, minimum, setMinimum }), [value, minimum]);
  return <DraftOfferContext.Provider value={context}>{children}</DraftOfferContext.Provider>;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export type PackageOption = { id: string; name: string; priceCents: number; active: boolean };
export type QuestionOption = { id: string; prompt: string; active: boolean; ruleGearIds: string[] };

type Addon = { id: string; rec: string; max: string };

const isWhole = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;
const gearUnit = (g: GearChoice) => ({ name: g.name, unit_label: g.unitLabel, pieces_per_unit: g.piecesPerUnit, piece_label: g.pieceLabel });

/**
 * The proposal draft's fields (packages, add-ons with this proposal's prices,
 * questions, expiry, intro) as the form saveDraft reads. Add-ons come from a
 * searchable catalog grouped by category; the chosen ones stay listed above
 * it. Each offered package and each charged item shows its standard price
 * and can have a price for this proposal only ("package_price:<package id>",
 * "price:<gear id>"); the catalog never changes. Every change is shared with
 * the live preview, which shows it before saving. One optional discount
 * (a percentage or a fixed amount, with a description) applies to the whole
 * proposal after every package, add-on and custom price.
 */
export function OfferEditor({
  currency,
  packages,
  gear,
  questions,
  initial,
}: {
  currency: string;
  packages: PackageOption[];
  gear: GearChoice[];
  questions: QuestionOption[];
  initial: DraftOfferInput;
}) {
  const shared = useContext(DraftOfferContext);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const money = (cents: number) => formatCents(cents, currency);

  const [slots, setSlots] = useState<[string, string, string]>(() => [0, 1, 2].map((i) => initial.packages[i]?.package_id ?? "") as [string, string, string]);
  const [popular, setPopular] = useState(() => String(initial.packages.findIndex((p) => p.is_popular) + 1 || ""));
  const [addons, setAddons] = useState<Addon[]>(() => initial.addons.map((a) => ({ id: a.gear_item_id, rec: String(a.recommended_quantity), max: String(a.max_quantity) })));
  const [asked, setAsked] = useState<string[]>(initial.question_ids);
  const [expiry, setExpiry] = useState(String(initial.expiry_days));
  const [intro, setIntro] = useState(initial.intro ?? "");
  // This proposal's prices, as typed (gear id or package id -> amount). Absent = standard price.
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial.price_overrides ?? []).flatMap((o) => ("gear_item_id" in o ? [[o.gear_item_id, centsToInputValue(o.unit_price_cents)]] : []))),
  );
  const [packagePrices, setPackagePrices] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial.price_overrides ?? []).flatMap((o) => ("package_id" in o ? [[o.package_id, centsToInputValue(o.unit_price_cents)]] : []))),
  );
  const packageById = useMemo(() => new Map(packages.map((p) => [p.id, p])), [packages]);
  const [discountKind, setDiscountKind] = useState<DiscountKind>(() => initial.discount?.type ?? "none");
  const [discountValue, setDiscountValue] = useState(() =>
    !initial.discount ? "" : initial.discount.type === "percent" ? basisPointsToInputValue(initial.discount.percent_basis_points) : centsToInputValue(initial.discount.amount_cents),
  );
  const [discountLabel, setDiscountLabel] = useState(() => initial.discount?.label ?? "");
  // The offer's lowest possible subtotal (from the preview, recalculated as packages,
  // prices and questions change): a fixed discount can't exceed it. The database checks it again.
  const minimumSubtotal = shared?.minimum ?? null;
  // The shape decides what the draft holds; the limit is shown here but doesn't pause the preview,
  // which recalculates it (the database refuses an amount over it when previewing or sending).
  const discountRead = readDiscount({ kind: discountKind, value: discountValue, label: discountLabel }, parseMoneyToCents);
  const discountLimit = readDiscount({ kind: discountKind, value: discountValue, label: discountLabel }, parseMoneyToCents, minimumSubtotal);

  const gearById = useMemo(() => new Map(gear.map((g) => [g.id, g])), [gear]);
  const chosenAddons = new Set(addons.map((a) => a.id));
  // Gear the asked questions' rules can require, beyond the add-ons: charged too, so it can have a price here.
  const ruleGear = [...new Set(questions.filter((q) => asked.includes(q.id)).flatMap((q) => q.ruleGearIds))].filter((id) => !chosenAddons.has(id) && gearById.has(id));
  const charged = new Set([...chosenAddons, ...ruleGear]);

  const override = (id: string) => customCents(prices[id], gearById.get(id)?.priceCents);

  // The offer these fields describe (what Save would store), or the first problem.
  const draft = useMemo((): Shared => {
    if (!isWhole(expiry, 1, 365)) return { offer: null, problem: "the offer must be valid for 1 to 365 days" };
    const addonInput: DraftOfferInput["addons"] = [];
    for (const a of addons) {
      if (!isWhole(a.rec, 0, 100) || !isWhole(a.max, 1, 100) || Number(a.rec) > Number(a.max)) return { offer: null, problem: "check the add-on quantities" };
      addonInput.push({ gear_item_id: a.id, recommended_quantity: Number(a.rec), max_quantity: Number(a.max) });
    }
    const overrides: PriceOverride[] = [];
    for (const id of new Set(slots.filter(Boolean))) {
      const cents = customCents(packagePrices[id], packageById.get(id)?.priceCents);
      if (cents === undefined) return { offer: null, problem: "enter custom prices like 1400 or 1400.00" };
      if (cents !== null) overrides.push({ package_id: id, unit_price_cents: cents });
    }
    for (const id of charged) {
      const cents = override(id);
      if (cents === undefined) return { offer: null, problem: "enter custom prices like 200 or 200.00" };
      if (cents !== null) overrides.push({ gear_item_id: id, unit_price_cents: cents });
    }
    if (!discountRead.ok) return { offer: null, problem: discountRead.error.charAt(0).toLowerCase() + discountRead.error.slice(1, -1) };
    const offer: DraftOfferInput = {
      template_id: initial.template_id,
      intro: intro.trim() || null,
      expiry_days: Number(expiry),
      packages: slots.flatMap((id, i) => (id ? [{ package_id: id, is_popular: popular === String(i + 1) }] : [])),
      addons: addonInput,
      question_ids: asked,
      ...(overrides.length > 0 ? { price_overrides: overrides } : {}),
      ...(discountRead.discount ? { discount: discountRead.discount } : {}),
    };
    return { offer, problem: null };
  }, [slots, popular, addons, asked, expiry, intro, prices, packagePrices, initial.template_id, discountKind, discountValue, discountLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    shared?.set(draft);
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Structural changes (adding or removing rows) change the form's fields
  // without an input event; announce one so the unsaved-changes state follows.
  const shape = JSON.stringify([addons.map((a) => a.id), asked, Object.keys(prices).sort(), Object.keys(packagePrices).sort()]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [shape]);

  const packageLabel = (p: PackageOption) => `${p.name} (${money(p.priceCents)})${p.active ? "" : " — archived"}`;
  const packageOptions = (current: string) => packages.filter((p) => p.active || p.id === current);

  function addAddon(id: string) {
    setAddons((l) => [...l, { id, rec: "0", max: "1" }]);
    window.requestAnimationFrame(() => document.getElementById(`addon-row-${id}`)?.querySelector<HTMLElement>("input")?.focus());
  }
  function removeAddon(id: string) {
    setAddons((l) => l.filter((a) => a.id !== id));
    // A custom price belongs to the add-on; it goes with it (unless a rule still charges the item).
    if (!ruleGearAfterRemoval(id)) setPrices((p) => setPrice(p, id, undefined));
  }
  function ruleGearAfterRemoval(id: string) {
    return questions.some((q) => asked.includes(q.id) && q.ruleGearIds.includes(id));
  }

  return (
    <div ref={box} className="grid min-w-0 gap-6" data-testid="offer-editor">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Three packages (exactly one recommended)</legend>
        {slots.map((id, i) => {
          const n = i + 1;
          const chosen = id ? packageById.get(id) : undefined;
          return (
            <div key={n} className="grid grid-cols-[1fr_auto] items-end gap-x-3 gap-y-1.5" data-testid="package-slot">
              <div className="grid gap-1.5">
                <label htmlFor={`package_${n}`} className="text-sm font-medium">{`Package ${n}`}</label>
                <select
                  id={`package_${n}`}
                  name={`package_${n}`}
                  value={id}
                  onChange={(e) => setSlots((s) => s.map((x, j) => (j === i ? e.target.value : x)) as [string, string, string])}
                  className={selectClass}
                >
                  <option value="">— none —</option>
                  {packageOptions(id).map((p) => (
                    <option key={p.id} value={p.id}>
                      {packageLabel(p)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex h-8 items-center gap-1.5 text-sm">
                <input type="radio" name="popular" value={String(n)} checked={popular === String(n)} onChange={() => setPopular(String(n))} className="size-4 accent-primary" />
                Recommended
              </label>
              {chosen ? (
                <div className="col-span-2">
                  <PriceEditor
                    id={`package-${n}`}
                    name={chosen.name}
                    field={`package_price:${chosen.id}`}
                    standardCents={chosen.priceCents}
                    unit="base price"
                    currency={currency}
                    value={packagePrices[chosen.id]}
                    onChange={(v) => setPackagePrices((p) => setPrice(p, chosen.id, v))}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <fieldset className="grid min-w-0 gap-3" data-testid="addons-editor">
        <legend className="mb-1 grid gap-0.5">
          <span className="text-sm font-medium">Add-ons</span>
          <span className="text-xs font-normal text-muted-foreground">
            Gear the client can add on top of their package. “Preselect” starts the client at that quantity. Prices can be changed for this proposal only.
          </span>
        </legend>
        {addons.length > 0 ? (
          <ul aria-label="Chosen add-ons" className="divide-y rounded-lg border">
            {addons.map((a) => {
              const g = gearById.get(a.id);
              const name = g?.name ?? "Unavailable gear item";
              const bad = !isWhole(a.rec, 0, 100) || !isWhole(a.max, 1, 100) || Number(a.rec) > Number(a.max);
              return (
                <li key={a.id} id={`addon-row-${a.id}`} data-testid="addon-row" className="grid gap-2 p-3">
                  <input type="hidden" name="addon" value={a.id} />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <GearThumb url={g?.thumbUrl ?? null} className="size-8" />
                    <span className="grid min-w-0 flex-1 basis-40">
                      <span className="truncate text-sm font-medium">{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {g?.category?.name ?? "Uncategorized"}
                        {g && !g.active ? <span className="text-destructive"> · archived: remove it or restore the gear item</span> : null}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        Preselect
                        <Input
                          name={`rec:${a.id}`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          value={a.rec}
                          aria-invalid={bad || undefined}
                          aria-label={`Preselected quantity of ${name}`}
                          onChange={(e) => setAddons((l) => l.map((x) => (x.id === a.id ? { ...x, rec: e.target.value } : x)))}
                          className="w-16"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        Up to
                        <Input
                          name={`max:${a.id}`}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={100}
                          value={a.max}
                          aria-invalid={bad || undefined}
                          aria-label={`Maximum quantity of ${name}`}
                          onChange={(e) => setAddons((l) => l.map((x) => (x.id === a.id ? { ...x, max: e.target.value } : x)))}
                          className="w-16"
                        />
                      </label>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => removeAddon(a.id)}>
                        <X aria-hidden />
                      </Button>
                    </span>
                  </div>
                  {bad ? <p role="alert" className="text-xs text-destructive">Preselect must be 0 to the maximum, and “Up to” 1 to 100.</p> : null}
                  {g ? <GearPriceEditor gear={g} currency={currency} value={prices[g.id]} onChange={(v) => setPrices((p) => setPrice(p, g.id, v))} /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No add-ons yet.</p>
        )}
        <ChoicePicker
          noun="gear"
          available={gear
            .filter((g) => g.active && !chosenAddons.has(g.id))
            .map((g) => ({ id: g.id, label: g.name, thumbUrl: g.thumbUrl, category: g.category, detail: `${money(g.priceCents)} ${perUnitText(gearUnit(g))}` }))}
          total={gear.filter((g) => g.active).length}
          onAdd={addAddon}
          thumbs
          emptyText="There is no active gear yet. Add gear items first."
          allAddedText="All active gear is offered as an add-on."
        />
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Logistics questions</legend>
        {/* Saved in the order they were chosen (a template's order is kept); newly ticked ones go last. */}
        {asked.map((id) => (
          <input key={id} type="hidden" name="question" value={id} />
        ))}
        {questions.filter((q) => q.active || asked.includes(q.id)).map((q) => (
          <label key={q.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              value={q.id}
              checked={asked.includes(q.id)}
              onChange={(e) => setAsked((l) => (e.target.checked ? [...l.filter((x) => x !== q.id), q.id] : l.filter((x) => x !== q.id)))}
              className="size-4 accent-primary"
            />
            {q.prompt}
            {q.active ? null : <span className="text-xs text-destructive">(archived)</span>}
          </label>
        ))}
      </fieldset>

      {ruleGear.length > 0 ? (
        <fieldset className="grid gap-2" data-testid="rule-gear-prices">
          <legend className="mb-1 grid gap-0.5">
            <span className="text-sm font-medium">Gear your questions can require</span>
            <span className="text-xs font-normal text-muted-foreground">Charged when an answer requires more than the package includes.</span>
          </legend>
          <ul className="divide-y rounded-lg border">
            {ruleGear.map((id) => {
              const g = gearById.get(id)!;
              return (
                <li key={id} className="grid gap-1 p-3">
                  <span className="text-sm font-medium">{g.name}</span>
                  <GearPriceEditor gear={g} currency={currency} value={prices[id]} onChange={(v) => setPrices((p) => setPrice(p, id, v))} />
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}

      <DiscountEditor
        currency={currency}
        kind={discountKind}
        value={discountValue}
        label={discountLabel}
        minimumSubtotal={minimumSubtotal}
        error={discountRead.ok ? (discountLimit.ok ? null : discountLimit.error) : discountRead.error}
        onKind={(k) => {
          setDiscountKind(k);
          if (k === "none") setDiscountValue("");
        }}
        onValue={setDiscountValue}
        onLabel={setDiscountLabel}
      />

      <TextField label="Offer valid for (days after sending)" name="expiry_days" type="number" min={1} max={365} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      <TextAreaField label="Intro shown to the client" name="intro" rows={4} maxLength={10000} value={intro} onChange={(e) => setIntro(e.target.value)} />
    </div>
  );
}

/**
 * The proposal's one discount: none, a percentage or a fixed amount, with an
 * optional description shown to the client ("Discount" when empty). It comes
 * off the subtotal after packages, add-ons and custom prices, before taxes.
 */
function DiscountEditor({
  currency,
  kind,
  value,
  label,
  minimumSubtotal,
  error,
  onKind,
  onValue,
  onLabel,
}: {
  currency: string;
  kind: DiscountKind;
  value: string;
  label: string;
  minimumSubtotal: number | null;
  error: string | null;
  onKind: (kind: DiscountKind) => void;
  onValue: (value: string) => void;
  onLabel: (label: string) => void;
}) {
  const kinds: [DiscountKind, string][] = [["none", "No discount"], ["percent", "Percentage"], ["fixed", "Fixed amount"]];
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3" data-testid="discount-editor">
      <legend className="grid gap-0.5 px-1">
        <span className="text-sm font-medium">Discount</span>
        <span className="text-xs font-normal text-muted-foreground">
          One discount on the whole proposal, taken off the subtotal (packages, add-ons and custom prices) before taxes. The client sees it in their price.
        </span>
      </legend>
      <div role="radiogroup" aria-label="Discount type" className="flex flex-wrap gap-x-4 gap-y-2">
        {kinds.map(([k, text]) => (
          <label key={k} className="flex items-center gap-1.5 text-sm">
            <input type="radio" name="discount_type" value={k} checked={kind === k} onChange={() => onKind(k)} className="size-4 accent-primary" />
            {text}
          </label>
        ))}
      </div>
      {kind === "none" ? null : (
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="grid gap-1.5">
            <label htmlFor="discount_value" className="text-sm font-medium">{kind === "percent" ? "Percent off" : `Amount off (${currency})`}</label>
            <div className="flex items-center gap-1.5">
              <Input
                id="discount_value"
                name="discount_value"
                inputMode="decimal"
                value={value}
                onChange={(e) => onValue(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby="discount_hint"
                className={cn("w-28", error && "border-destructive")}
              />
              {kind === "percent" ? <span className="text-sm text-muted-foreground">%</span> : null}
            </div>
          </div>
          <TextField
            label="Description (optional)"
            name="discount_label"
            value={label}
            maxLength={80}
            placeholder="Discount"
            onChange={(e) => onLabel(e.target.value)}
          />
          <p id="discount_hint" className="text-xs text-muted-foreground sm:col-span-2">
            {kind === "percent"
              ? "From 0 to 100, like 10 or 12.5. Rounded to the cent."
              : minimumSubtotal !== null
                ? `Up to ${formatCents(minimumSubtotal, currency)}, the lowest subtotal a client can choose (the cheapest package with any required gear, before optional add-ons).`
                : "Up to the lowest subtotal a client can choose."}{" "}
            Like “Wedding Special” or “Returning Client Discount”.
          </p>
          {error ? <p role="alert" className="text-xs text-destructive sm:col-span-2">{error}</p> : null}
        </div>
      )}
    </fieldset>
  );
}

function setPrice(prices: Record<string, string>, id: string, value: string | undefined): Record<string, string> {
  const next = { ...prices };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

/** A typed price that differs from the standard one, in cents; null when standard or empty; undefined when it isn't a valid amount. */
function customCents(typed: string | undefined, standard: number | undefined): number | null | undefined {
  if (typed === undefined || typed.trim() === "") return null;
  const cents = parseMoneyToCents(typed);
  if (cents === null || cents > 100_000_000) return undefined;
  return cents === standard ? null : cents;
}

function GearPriceEditor({ gear, ...rest }: { gear: GearChoice; currency: string; value: string | undefined; onChange: (value: string | undefined) => void }) {
  return <PriceEditor id={gear.id} name={gear.name} field={`price:${gear.id}`} standardCents={gear.priceCents} unit={perUnitText(gearUnit(gear))} {...rest} />;
}

/**
 * Standard price, this proposal's price, Edit price and Reset, for a package
 * base price or a gear item. A custom price is a form field (`field`); equal
 * to the standard price, or reset, there is none.
 */
function PriceEditor({
  id,
  name,
  field,
  standardCents,
  unit,
  currency,
  value,
  onChange,
}: {
  id: string;
  name: string;
  field: string;
  standardCents: number;
  /** "per pair (2 lights)", "base price". */
  unit: string;
  currency: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const money = (cents: number) => formatCents(cents, currency);
  const [editing, setEditing] = useState(false);
  const inputId = `price-${id}`;
  const cents = customCents(value, standardCents);
  const invalid = cents === undefined;
  const custom = typeof cents === "number";

  if (!editing && !custom && !invalid) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="price-standard">
        <span>
          <span className="font-medium text-foreground">{money(standardCents)}</span> {unit} · standard price
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          aria-label={`Edit price of ${name} for this proposal`}
          onClick={() => {
            setEditing(true);
            onChange(value ?? centsToInputValue(standardCents));
            window.requestAnimationFrame(() => document.getElementById(inputId)?.focus());
          }}
        >
          <Pencil aria-hidden />
          Edit price
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="price-custom">
      <label htmlFor={inputId} className="text-muted-foreground">
        This proposal ({currency})
      </label>
      <Input
        id={inputId}
        // Only a price that differs from the standard one is saved.
        name={custom || invalid ? field : undefined}
        inputMode="decimal"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        aria-invalid={invalid || undefined}
        aria-describedby={`${inputId}-std`}
        className={cn("h-8 w-28", invalid && "border-destructive")}
      />
      <span id={`${inputId}-std`} className="text-muted-foreground">
        {unit}. Standard {money(standardCents)}
      </span>
      {custom ? <Badge variant="secondary">Custom price</Badge> : null}
      {invalid ? <span role="alert" className="text-destructive">Enter an amount like 200 or 200.00.</span> : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        aria-label={`Reset ${name} to the standard price`}
        // Keeps the input's blur from closing before the click lands.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setEditing(false);
          onChange(undefined);
        }}
      >
        <RotateCcw aria-hidden />
        Reset
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

type EventInfo = { title: string; event_date: string; venue_name: string | null };

/**
 * The client preview. With no unsaved edits it is the saved draft's preview
 * (rendered by the page); while the editor has unsaved edits it shows them,
 * built by the database exactly as sending would (previewDraftOffer), a
 * moment after typing stops. Nothing is saved; a newer edit supersedes a
 * slower response, so the preview never shows an older state.
 */
export function LivePreview({ slug, proposalId, saved, event, mediaBase }: { slug: string; proposalId: string; saved: DraftPreview; event: EventInfo; mediaBase: string }) {
  const draft = useContext(DraftOfferContext)?.value ?? { offer: null, problem: null };
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  const json = draft.offer ? JSON.stringify(draft.offer) : null;
  const [live, setLive] = useState<{ json: string; result: DraftPreview } | null>(null);
  const latest = useRef(0);
  const wanted = unsaved && json !== null && live?.json !== json;

  useEffect(() => {
    if (!wanted || json === null) return;
    const request = ++latest.current;
    const timer = window.setTimeout(async () => {
      let result: DraftPreview;
      try {
        result = await previewDraftOffer(slug, proposalId, JSON.parse(json));
      } catch {
        result = { ok: false, message: "The preview couldn't be updated. Check your connection." };
      }
      if (request === latest.current) setLive({ json, result });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [wanted, json, slug, proposalId]);

  const current = live && live.json === json ? live.result : null;
  const setMinimum = useContext(DraftOfferContext)?.setMinimum;
  // Saved and no newer edit shown: the page's preview of the saved draft.
  const shown = unsaved ? (current ?? live?.result ?? saved) : (current ?? saved);
  const showsSaved = shown === saved;
  // The offer's lowest possible subtotal, for the fixed discount's limit; kept while a preview is refused.
  const minimum = shown.ok ? minimumSelectionSubtotal(shown.offer) : (shown.minimumSubtotalCents ?? null);
  useEffect(() => {
    if (minimum !== null) setMinimum?.(minimum);
  }, [minimum, setMinimum]);
  const status = draft.problem && unsaved
    ? { tone: "warn", text: `Preview paused: ${draft.problem}.` }
    : wanted
      ? { tone: "busy", text: "Updating the preview…" }
      : unsaved
        ? { tone: "warn", text: "Showing your unsaved changes. Save the draft before sending." }
        : { tone: "ok", text: "Shows the saved draft." };

  return (
    <div className="grid gap-3">
      <p role="status" data-testid="preview-status" className={cn("text-xs", status.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
        {status.text}
      </p>
      <div className={cn("transition-opacity", status.tone === "busy" && "opacity-60")} aria-busy={status.tone === "busy"}>
        {shown.ok ? (
          // A new offer starts again from the recommended choices, as a client would see it.
          <ProposalPreview key={showsSaved ? "saved" : (live?.json ?? "saved")} offer={shown.offer} mediaBase={mediaBase} logo={shown.logo} event={event} contained />
        ) : (
          <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            {shown.message} <TaxSetupLink slug={slug} message={shown.message} />
          </p>
        )}
      </div>
    </div>
  );
}
