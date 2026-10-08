"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GearThumb } from "@/components/app/gear-thumb";
import { ChoicePicker } from "@/components/app/choice-picker";
import type { GearChoice } from "@/lib/catalog/gear-choices.server";

type Row = { id: string; qty: string };

/**
 * The package's included gear inside a form, as "qty:<gear id>" fields
 * (savePackageItems / createPackage): each item once, a quantity from 1 to
 * 100, Add from the catalog (searchable when it's long) and Remove. Gear
 * that is archived but already included stays listed and is explained,
 * never dropped silently.
 */
export function IncludedGearEditor({ choices, initial, capped }: { choices: GearChoice[]; initial: { id: string; quantity: number }[]; capped?: boolean }) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((i) => ({ id: i.id, qty: String(i.quantity) })));
  const box = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const first = useRef(true);
  const byId = useMemo(() => new Map(choices.map((c) => [c.id, c])), [choices]);
  const chosen = new Set(rows.map((r) => r.id));
  // Archived gear can be kept, not newly added.
  const available = choices.filter((c) => !chosen.has(c.id) && c.active);

  // Adding or removing a row changes the form's fields without an input
  // event; announce one so the form's unsaved-changes state follows.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [rows.length]);

  function add(id: string) {
    setRows((r) => [...r, { id, qty: "1" }]);
    window.requestAnimationFrame(() => document.getElementById(`qty-${id}`)?.focus());
  }

  function remove(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
    window.requestAnimationFrame(() => (searchRef.current ?? box.current?.querySelector<HTMLElement>("[data-add]"))?.focus());
  }

  return (
    <div ref={box} className="grid gap-3" data-testid="included-gear-editor">
      {rows.length > 0 ? (
        <ul aria-label="Included gear" className="divide-y rounded-lg border">
          {rows.map((row) => {
            const g = byId.get(row.id);
            const name = g?.name ?? "Unavailable gear item";
            return (
              <li key={row.id} data-testid="included-row" className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <GearThumb url={g?.thumbUrl ?? null} />
                  <div className="grid min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{name}</span>
                      {g && !g.active ? <Badge variant="secondary">Archived gear</Badge> : null}
                    </span>
                    {g && !g.active ? (
                      <span className="text-xs text-amber-800 dark:text-amber-300">
                        Proposals with this package can&apos;t be previewed or sent while it&apos;s included. Remove it here, or restore the gear item.
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`qty-${row.id}`} className="text-xs text-muted-foreground">
                    Quantity
                  </label>
                  <Input
                    id={`qty-${row.id}`}
                    name={`qty:${row.id}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    required
                    value={row.qty}
                    onChange={(e) => setRows((r) => r.map((x) => (x.id === row.id ? { ...x, qty: e.target.value } : x)))}
                    aria-label={`Quantity of ${name}`}
                    className="w-20"
                  />
                  {g ? <span className="text-xs text-muted-foreground">{g.unitLabel}</span> : null}
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => remove(row.id)}>
                    <X aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="included-empty">No gear included yet.</p>
      )}

      <ChoicePicker
        ref={searchRef}
        noun="gear"
        available={available.map((c) => ({ id: c.id, label: c.name, thumbUrl: c.thumbUrl }))}
        total={choices.filter((c) => c.active).length}
        onAdd={add}
        thumbs
        emptyText="There is no active gear yet. Add gear items first."
        allAddedText="All active gear is included."
      />
      {capped ? <p className="text-xs text-muted-foreground">Only the first gear items by name are offered here.</p> : null}
      <p className="text-xs text-muted-foreground">Each item is included once, with a quantity from 1 to 100. Included gear is covered by the base price.</p>
    </div>
  );
}
