import type { ReactNode } from "react";
import { FieldGroup as Group, TaxCategoryField } from "@/components/app/catalog-fields";
import { TextAreaField, TextField } from "@/components/app/fields";
import { centsToInputValue } from "@/lib/money";

type Pkg = { key: string; name: string; description: string | null; base_price_cents: number; tax_category: string; sort_order: number };

/**
 * The package form: name and description, pricing and tax, then (when
 * creating) the included gear, then the less-used settings and key.
 */
export function PackageFields({
  pkg,
  taxCategories,
  currency,
  slug,
  isNew,
  includedGear,
}: {
  pkg?: Pkg;
  /** Categories configured in Settings. */
  taxCategories: string[];
  currency: string;
  slug: string;
  isNew?: boolean;
  /** The included-gear editor, when it's part of this form. */
  includedGear?: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">All fields are required unless marked optional.</p>
      <Group legend="Name and description">
        <TextField label="Name" name="name" required maxLength={200} defaultValue={pkg?.name} placeholder="Signature" className="sm:col-span-2" />
        <TextAreaField
          className="sm:col-span-2"
          label="Description (optional)"
          name="description"
          rows={3}
          maxLength={5000}
          defaultValue={pkg?.description ?? ""}
          hint="Shown to clients on proposals."
        />
      </Group>
      <Group legend="Pricing and tax" hint="The client pays this one price for the package. Its included gear is part of it and never charged separately.">
        <TextField
          label={`Base price (${currency})`}
          name="price"
          inputMode="decimal"
          required
          defaultValue={pkg ? centsToInputValue(pkg.base_price_cents) : ""}
          placeholder="2200.00"
          hint="Before tax. For example 2200 or 2200.00."
        />
        <TaxCategoryField configured={taxCategories} current={pkg?.tax_category} slug={slug} noun="package" />
      </Group>
      {includedGear ? (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="mb-3 grid gap-0.5">
            <span className="text-sm font-semibold">Included gear (optional)</span>
            <span className="text-xs font-normal text-muted-foreground">Shown on proposals as part of the package. You can change it later.</span>
          </legend>
          {includedGear}
        </fieldset>
      ) : null}
      <Group legend="Other settings">
        <TextField
          label="Display order"
          name="sort_order"
          type="number"
          min={0}
          max={10000}
          required
          defaultValue={pkg?.sort_order ?? 0}
          hint="Lower numbers come first where staff choose packages for templates and proposals."
        />
        {isNew ? (
          <TextField
            label="Key (optional)"
            name="key"
            maxLength={64}
            pattern="[a-z][a-z0-9_]*"
            placeholder="signature"
            hint="A stable identifier used in offers. Made from the name if left empty. It can't change later."
          />
        ) : (
          <TextField label="Key" name="key_display" defaultValue={pkg?.key} disabled hint="Keys never change." />
        )}
      </Group>
    </div>
  );
}
