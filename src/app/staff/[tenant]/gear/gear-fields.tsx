import { FieldGroup as Group, TaxCategoryField } from "@/components/app/catalog-fields";
import { TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";

type Gear = {
  key: string;
  name: string;
  description: string | null;
  unit_label: string;
  default_price_cents: number;
  tax_category: string;
};

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
        <TaxCategoryField configured={taxCategories} current={gear?.tax_category} slug={slug} noun="item" />
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
