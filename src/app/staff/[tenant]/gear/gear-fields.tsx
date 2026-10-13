import { FieldGroup as Group, TaxCategoryField } from "@/components/app/catalog-fields";
import { TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";
import { CategoryField } from "./category-field";

type Gear = {
  key: string;
  name: string;
  description: string | null;
  unit_label: string;
  default_price_cents: number;
  tax_category: string;
  category_id: string | null;
  pieces_per_unit: number;
  piece_label: string | null;
};

/** The gear item form: name, category and description, pricing and what one unit holds, then the reference key. */
export function GearFields({
  gear,
  taxCategories,
  categories,
  currency,
  slug,
  isNew,
}: {
  gear?: Gear;
  /** Categories configured in Settings. */
  taxCategories: string[];
  /** The business's gear categories. */
  categories: { id: string; name: string }[];
  currency: string;
  slug: string;
  isNew?: boolean;
}) {
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">All fields are required unless marked optional.</p>
      <Group legend="Name and description">
        <TextField label="Name" name="name" required maxLength={200} defaultValue={gear?.name} placeholder="Ceremony speaker" className="sm:col-span-2" />
        <CategoryField categories={categories} current={gear?.category_id} />
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
        <TextField label="Unit (optional)" name="unit_label" maxLength={40} defaultValue={gear?.unit_label ?? "unit"} hint="What one unit is: speaker, pair, set." />
        <TaxCategoryField configured={taxCategories} current={gear?.tax_category} slug={slug} noun="item" />
      </Group>
      <Group
        legend="What one unit holds"
        hint="For gear sold in pairs or sets. A pair of moving heads: unit “pair”, 2 pieces, called “lights”. Clients then see “1 pair of Moving Heads (2 lights)”. The price stays per unit."
      >
        <TextField
          label="Pieces per unit"
          name="pieces_per_unit"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          step={1}
          required
          defaultValue={gear?.pieces_per_unit ?? 1}
          hint="1 for a single item."
        />
        <TextField
          label="Pieces are called (optional)"
          name="piece_label"
          maxLength={40}
          defaultValue={gear?.piece_label ?? ""}
          placeholder="lights"
          hint="Plural, shown when a unit holds more than one: lights, tubes, speakers."
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
