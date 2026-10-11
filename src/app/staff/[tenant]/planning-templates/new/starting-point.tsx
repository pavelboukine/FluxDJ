"use client";

import { useState } from "react";
import { TextAreaField, TextField } from "@/components/app/fields";
import { cn } from "@/lib/utils";

export type StartingPoint = { value: string; label: string; detail: string; suggestedName: string };

/**
 * The starting point of a new planning template (radio cards), its name and,
 * unless it copies a template (which keeps that template's description), an
 * optional description. Choosing another starting point suggests its name
 * only while the name hasn't been typed.
 */
export function StartingPointFields({ outlines, copies, initial }: { outlines: StartingPoint[]; copies: StartingPoint[]; initial: string }) {
  const all = [...outlines, ...copies];
  const [start, setStart] = useState(initial);
  const [name, setName] = useState(all.find((o) => o.value === initial)?.suggestedName ?? "");
  const [typed, setTyped] = useState(false);

  function choose(value: string) {
    setStart(value);
    if (!typed) setName(all.find((o) => o.value === value)?.suggestedName ?? "");
  }

  const group = (legend: string, hint: string, options: StartingPoint[]) =>
    options.length === 0 ? null : (
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{legend}</legend>
        <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                start === o.value ? "border-primary bg-primary/5" : "hover:bg-muted/50",
              )}
            >
              <input type="radio" name="start" value={o.value} checked={start === o.value} onChange={() => choose(o.value)} className="mt-0.5 size-4 accent-primary" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium [overflow-wrap:anywhere]">{o.label}</span>
                <span className="text-xs text-muted-foreground">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );

  return (
    <div className="grid gap-6">
      {group("Start from an outline", "Flux's suggested structure. You can rename, reorder and trim everything afterwards.", outlines)}
      {group("Or copy one of your templates", "Keeps its labels, order and description.", copies)}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Template name"
          name="name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setTyped(true);
          }}
          hint="Staff see this name when choosing a template for an event."
        />
        {start.startsWith("copy:") ? null : (
          <TextAreaField className="sm:col-span-2" label="Description (optional)" name="description" rows={2} maxLength={1000} hint={start === "basics" ? "For your team; clients don't see it." : "For your team; clients don't see it. Leave it empty to use the outline's description."} />
        )}
      </div>
    </div>
  );
}
