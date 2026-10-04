"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/app/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KEY_RE, type ActionState } from "@/lib/forms";
import {
  MAX_TAX_CATEGORIES,
  MAX_TAXES,
  ppmToPercent,
  usageText,
  type CategoryMode,
  type CategoryUsage,
  type TaxCategories,
  type TaxRate,
} from "@/lib/pricing/tax-settings";

type Row = { id: string; code: string; label: string; rate: string };
type Mapping = { mode: CategoryMode; rows: string[] };

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  version: number;
  rates: TaxRate[];
  categories: TaxCategories;
  usage: CategoryUsage[];
};

/**
 * Edits the tax list and the category mapping. Every category shows one of
 * three explicit states: not configured (offers using it can't be sent),
 * no tax, or a set of taxes. The server assigns codes to new taxes.
 */
export function TaxSettingsForm({ action, version, rates, categories, usage }: Props) {
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>(() => rates.map((r) => ({ id: `t_${r.code}`, code: r.code, label: r.label, rate: ppmToPercent(r.rate_ppm) })));
  const [keys, setKeys] = useState<string[]>(() => {
    const all = new Set(["standard", ...usage.map((u) => u.key), ...Object.keys(categories)]);
    return [...all].sort((a, b) => (a === "standard" ? -1 : b === "standard" ? 1 : a.localeCompare(b)));
  });
  const [mapping, setMapping] = useState<Record<string, Mapping>>(() =>
    Object.fromEntries(
      Object.entries(categories).map(([key, codes]) => [key, codes.length ? { mode: "taxes", rows: codes.map((c) => `t_${c}`) } : { mode: "none", rows: [] }]),
    ),
  );
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  // Adding or removing rows changes the form without an input event; tell
  // ActionForm so its "Unsaved changes" indicator stays accurate.
  const sentinel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    sentinel.current?.dispatchEvent(new Event("change", { bubbles: true }));
  }, [rows.length, keys.length, mapping]);

  const mapFor = (key: string): Mapping => mapping[key] ?? { mode: "unset", rows: [] };
  const setMode = (key: string, mode: CategoryMode) => setMapping((m) => ({ ...m, [key]: { ...mapFor(key), mode } }));
  const toggleTax = (key: string, row: string, on: boolean) =>
    setMapping((m) => {
      const current = m[key] ?? { mode: "taxes" as const, rows: [] };
      return { ...m, [key]: { mode: "taxes", rows: on ? [...current.rows.filter((r) => r !== row), row] : current.rows.filter((r) => r !== row) } };
    });

  function addTax() {
    setRows((r) => [...r, { id: `n_${nextId.current++}`, code: "", label: "", rate: "" }]);
  }
  function removeTax(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
    setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, rows: v.rows.filter((r) => r !== id) }])));
  }
  function addCategory() {
    const key = newKey.trim();
    if (!KEY_RE.test(key)) return setKeyError("Use lowercase letters, digits and underscores, starting with a letter (for example exempt).");
    if (keys.includes(key)) return setKeyError("That category is already listed.");
    if (keys.length >= MAX_TAX_CATEGORIES) return setKeyError(`At most ${MAX_TAX_CATEGORIES} categories.`);
    setKeys((k) => [...k, key]);
    setNewKey("");
    setKeyError(null);
  }

  return (
    <ActionForm action={action} version={version} submitLabel="Save tax settings" trackUnsaved>
      <span ref={sentinel} hidden />
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Taxes</legend>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No taxes yet. Add the taxes you charge, with their exact rates.</p> : null}
        {rows.map((row, i) => (
          <div key={row.id} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2" data-testid="tax-row">
            <input type="hidden" name="tax_row" value={row.id} />
            <input type="hidden" name={`tax_code:${row.id}`} value={row.code} />
            <div className="grid gap-1.5">
              <Label htmlFor={`tax_label_${row.id}`}>Tax {i + 1} name</Label>
              <Input
                id={`tax_label_${row.id}`}
                name={`tax_label:${row.id}`}
                required
                maxLength={40}
                value={row.label}
                onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, label: e.target.value } : r)))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`tax_rate_${row.id}`}>Tax {i + 1} rate (%)</Label>
              <Input
                id={`tax_rate_${row.id}`}
                name={`tax_rate:${row.id}`}
                required
                inputMode="decimal"
                autoComplete="off"
                value={row.rate}
                onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, rate: e.target.value } : r)))}
              />
            </div>
            <Button type="button" variant="outline" onClick={() => removeTax(row.id)} aria-label={`Remove tax ${i + 1}${row.label ? ` (${row.label})` : ""}`}>
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={addTax} disabled={rows.length >= MAX_TAXES}>
            Add tax
          </Button>
          <p className="text-xs text-muted-foreground">Rates are exact percentages with up to 4 decimals, for example 5 or 9.975. Up to {MAX_TAXES} taxes.</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-sm font-medium">Tax categories</legend>
        <p className="text-sm text-muted-foreground">
          Each gear item and package has a tax category. Choose which taxes apply to each one. A category that is not configured blocks
          sending any offer that uses it; “No tax” is a deliberate choice.
        </p>
        {keys.map((key) => {
          const m = mapFor(key);
          const u = usage.find((x) => x.key === key);
          return (
            <div key={key} role="group" aria-label={`Category ${key}`} className="grid gap-2 rounded-lg border p-3">
              <input type="hidden" name="category" value={key} />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-medium">{key}</span>
                <span className="text-xs text-muted-foreground">{usageText(u)}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {(
                  [
                    ["unset", "Not configured"],
                    ["none", "No tax"],
                    ["taxes", "Apply taxes"],
                  ] as const
                ).map(([mode, label]) => (
                  <label key={mode} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`category_mode:${key}`}
                      value={mode}
                      checked={m.mode === mode}
                      onChange={() => setMode(key, mode)}
                      className="size-4 accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {m.mode === "taxes" ? (
                rows.length === 0 ? (
                  <p className="text-sm text-amber-700 dark:text-amber-400">Add a tax above first.</p>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {rows.map((row, i) => (
                      <label key={row.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name={`category_tax:${key}`}
                          value={row.id}
                          checked={m.rows.includes(row.id)}
                          onChange={(e) => toggleTax(key, row.id, e.target.checked)}
                          className="size-4 accent-primary"
                        />
                        {row.label || `Tax ${i + 1}`}
                      </label>
                    ))}
                  </div>
                )
              ) : null}
              {m.mode === "unset" && u && (u.gear || u.packages) ? (
                <p className="text-sm text-amber-700 dark:text-amber-400">Offers that include these items can&apos;t be previewed or sent until this is configured.</p>
              ) : null}
            </div>
          );
        })}
        <div className="grid gap-1.5">
          <Label htmlFor="new_tax_category">Add a category</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="new_tax_category"
              className="max-w-60"
              value={newKey}
              placeholder="exempt"
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCategory();
                }
              }}
            />
            <Button type="button" variant="secondary" onClick={addCategory}>
              Add category
            </Button>
          </div>
          {keyError ? <p role="alert" className="text-sm text-destructive">{keyError}</p> : null}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Changes apply to offers sent from now on. Proposals and contracts already sent keep the taxes they were sent with.
      </p>
    </ActionForm>
  );
}
