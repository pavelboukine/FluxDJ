"use client";

import { useState } from "react";
import { Field, selectClass } from "@/components/app/fields";
import { Input } from "@/components/ui/input";
import { CATEGORY_NAME_MAX, missingSuggestions } from "@/lib/catalog/categories";

/**
 * The gear form's category: none, one of the business's categories, a
 * suggested one (created when the item is saved), or a new name. Sent as
 * category_id: "", a category id, "new:<suggested name>" or "new" with
 * new_category.
 */
export function CategoryField({ categories, current }: { categories: { id: string; name: string }[]; current?: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const suggestions = missingSuggestions(categories.map((c) => c.name));
  return (
    <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
      <Field
        label="Category (optional)"
        htmlFor="category_id"
        hint="Groups this item in your catalog and in a proposal's add-ons."
      >
        <select id="category_id" name="category_id" value={value} onChange={(e) => setValue(e.target.value)} className={selectClass}>
          <option value="">Uncategorized</option>
          {categories.length > 0 ? (
            <optgroup label="Your categories">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {suggestions.length > 0 ? (
            <optgroup label="Suggested">
              {suggestions.map((name) => (
                <option key={name} value={`new:${name}`}>
                  {name}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value="new">New category…</option>
        </select>
      </Field>
      {value === "new" ? (
        <Field label="New category name" htmlFor="new_category" hint="Created when you save.">
          <Input id="new_category" name="new_category" required maxLength={CATEGORY_NAME_MAX} placeholder="Photo booth" autoFocus />
        </Field>
      ) : null}
    </div>
  );
}
