import type { ReactNode } from "react";
import Link from "next/link";
import { SelectField } from "@/components/app/fields";

/* Shared pieces of the catalog forms (gear, packages). */

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

export function FieldGroup({ legend, hint, children }: { legend: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
      <legend className="mb-3 grid gap-0.5">
        <span className="text-sm font-semibold">{legend}</span>
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * The tax category select of a catalog form, with guidance when taxes aren't
 * set up yet (offers using an unconfigured category can't be sent). Nothing
 * is pre-chosen beyond the current value, or "standard" when configured.
 */
export function TaxCategoryField({ configured, current, slug, noun }: { configured: string[]; current?: string; slug: string; noun: "item" | "package" }) {
  const options = taxCategoryOptions(configured, current);
  const selected = current ?? (configured.includes("standard") ? "standard" : options[0]?.value);
  const settings = `/staff/${slug}/settings#taxes`;
  return (
    <SelectField
      label="Tax category"
      name="tax_category"
      required
      defaultValue={selected}
      options={options}
      hint={
        configured.length === 0 ? (
          <>
            No taxes are set up yet, so proposals with this {noun} can&apos;t be sent until they are.{" "}
            <Link className="font-medium underline" href={settings}>Open tax settings</Link> (owner only).
          </>
        ) : (
          <>
            Which taxes apply is set per category in <Link className="underline" href={settings}>tax settings</Link>.
          </>
        )
      }
    />
  );
}
