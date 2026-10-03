import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";

type Pkg = { key: string; name: string; description: string | null; base_price_cents: number; tax_category: string; sort_order: number; is_popular: boolean; active: boolean };

export function PackageFields({ pkg, taxCategories, isNew }: { pkg?: Pkg; taxCategories: string[]; isNew?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField label="Name" name="name" required maxLength={200} defaultValue={pkg?.name} placeholder="Signature" />
      {isNew ? (
        <TextField label="Key (optional)" name="key" maxLength={64} pattern="[a-z][a-z0-9_]*" placeholder="signature" hint="Generated from the name if empty. Cannot change later." />
      ) : (
        <TextField label="Key" name="key_display" defaultValue={pkg?.key} disabled hint="Keys never change." />
      )}
      <TextField label="Base price (CAD)" name="price" inputMode="decimal" required defaultValue={pkg ? centsToInputValue(pkg.base_price_cents) : ""} placeholder="2200.00" hint="Included gear is covered by this price." />
      <SelectField label="Tax category" name="tax_category" defaultValue={pkg?.tax_category ?? (taxCategories.includes("standard") ? "standard" : taxCategories[0])} options={taxCategories.map((c) => ({ value: c, label: c }))} />
      <TextField label="Display order" name="sort_order" type="number" min={0} max={10000} defaultValue={pkg?.sort_order ?? 0} />
      <CheckboxField label="Mark as most popular by default" name="is_popular" defaultChecked={pkg?.is_popular} hint="Each proposal still chooses exactly one most-popular package." />
      <TextAreaField className="sm:col-span-2" label="Description" name="description" rows={3} maxLength={5000} defaultValue={pkg?.description ?? ""} />
      {!isNew ? <CheckboxField label="Active (available for new proposals)" name="active" defaultChecked={pkg?.active} /> : null}
    </div>
  );
}
