import type { ReactNode } from "react";
import Link from "next/link";
import { SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";

type Gear = {
  key: string;
  name: string;
  description: string | null;
  unit_label: string;
  default_price_cents: number;
  tax_category: string;
};

/**
 * Tax category choices: the categories configured in Settings. With none
 * configured yet, "standard" (the category Settings always offers). The
 * item's current category is always kept as an option, so an edit never
 * silently changes it; the server still accepts only configured ones.
 */
export function taxCategoryOptions(configured: string[], current?: string) {
  const keys = configured.length > 0 ? configured : ["standard"];
  const all = current && !keys.includes(current) ? [current, ...keys] : keys;
  return all.map((c) => ({ value: c, label: configured.includes(c) ? c : `${c} (taxes not set up)` }));
}

function Group({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-3 grid gap-0.5">
        <span className="text-sm font-semibold">{legend}</span>
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

/** The gear item form: name and description, pricing and tax, then the reference key. */
export function GearFields({
  gear,
  taxCategories,
  currency,
  slug,
  isNew,
}: {
  gear?: Gear;
  /** Categories configured in Settings. */
  taxCategories: string[];
  currency: string;
  slug: string;
  isNew?: boolean;
}) {
  const options = taxCategoryOptions(taxCategories, gear?.tax_category);
  const selected = gear?.tax_category ?? (taxCategories.includes("standard") ? "standard" : options[0]?.value);
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">All fields are required unless marked optional.</p>
      <Group legend="Name and description">
        <TextField label="Name" name="name" required maxLength={200} defaultValue={gear?.name} placeholder="Ceremony speaker" className="sm:col-span-2" />
        <TextAreaField
          className="sm:col-span-2"
          label="Description (optional)"
          name="description"
          rows={3}
          maxLength={5000}
          defaultValue={gear?.description ?? ""}
          hint="Shown to clients on proposals."
        />
      </Group>
      <Group legend="Pricing and tax" hint="Charged per unit when the client adds it or a rule requires it. Quantities a package includes are not charged again.">
        <TextField
          label={`Unit price (${currency})`}
          name="price"
          inputMode="decimal"
          required
          defaultValue={gear ? centsToInputValue(gear.default_price_cents) : ""}
          placeholder="150.00"
          hint="Before tax. For example 150 or 150.00."
        />
        <TextField label="Unit (optional)" name="unit_label" maxLength={40} defaultValue={gear?.unit_label ?? "unit"} hint="What one unit is: speaker, pack, set." />
        <SelectField
          label="Tax category"
          name="tax_category"
          required
          defaultValue={selected}
          options={options}
          hint={
            taxCategories.length === 0 ? (
              <>
                No taxes are set up yet, so proposals with this item can&apos;t be sent until they are.{" "}
                <Link className="font-medium underline" href={`/staff/${slug}/settings#taxes`}>Open tax settings</Link> (owner only).
              </>
            ) : (
              <>
                Which taxes apply is set per category in <Link className="underline" href={`/staff/${slug}/settings#taxes`}>tax settings</Link>.
              </>
            )
          }
        />
      </Group>
      <Group legend="Reference">
        {isNew ? (
          <TextField
            label="Key (optional)"
            name="key"
            maxLength={64}
            pattern="[a-z][a-z0-9_]*"
            placeholder="ceremony_speaker"
            hint="A stable identifier used in offers. Made from the name if left empty. It can't change later."
          />
        ) : (
          <TextField label="Key" name="key_display" defaultValue={gear?.key} disabled hint="Keys never change." />
        )}
      </Group>
    </div>
  );
}
