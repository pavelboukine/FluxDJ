import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";

type Gear = {
  key: string;
  name: string;
  description: string | null;
  unit_label: string;
  default_price_cents: number;
  tax_category: string;
  active: boolean;
};

export function GearFields({ gear, taxCategories, isNew }: { gear?: Gear; taxCategories: string[]; isNew?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField label="Name" name="name" required maxLength={200} defaultValue={gear?.name} placeholder="Ceremony speaker" />
      {isNew ? (
        <TextField
          label="Key (optional)"
          name="key"
          maxLength={64}
          pattern="[a-z][a-z0-9_]*"
          placeholder="ceremony_speaker"
          hint="Stable identifier used in offers. Generated from the name if empty. Cannot change later."
        />
      ) : (
        <TextField label="Key" name="key_display" defaultValue={gear?.key} disabled hint="Keys never change." />
      )}
      <TextField label="Price (CAD)" name="price" inputMode="decimal" required defaultValue={gear ? centsToInputValue(gear.default_price_cents) : ""} placeholder="150.00" />
      <TextField label="Unit label" name="unit_label" maxLength={40} defaultValue={gear?.unit_label ?? "unit"} hint="For example: speaker, pack, set." />
      <SelectField
        label="Tax category"
        name="tax_category"
        defaultValue={gear?.tax_category ?? (taxCategories.includes("standard") ? "standard" : taxCategories[0])}
        options={taxCategories.map((c) => ({ value: c, label: c }))}
        hint={taxCategories.length === 0 ? "No tax categories configured for this business yet." : undefined}
      />
      <TextAreaField className="sm:col-span-2" label="Description" name="description" rows={3} maxLength={5000} defaultValue={gear?.description ?? ""} />
      {!isNew ? <CheckboxField label="Active (offered in new proposals)" name="active" defaultChecked={gear?.active} hint="Archive instead of deleting: sent proposals keep their copy." /> : null}
    </div>
  );
}
