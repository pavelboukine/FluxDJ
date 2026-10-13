"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionForm, FormMessage } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { TextField } from "@/components/app/fields";
import { CATEGORY_NAME_MAX } from "@/lib/catalog/categories";
import { idleState, type ActionState } from "@/lib/forms";
import { createCategory, deleteCategory, moveCategory, renameCategory } from "./actions";

type Category = { id: string; name: string; items: number };

/**
 * The business's gear categories, folded away under the list: add, rename,
 * order (the order add-ons are grouped in) and delete (its gear becomes
 * uncategorized). Gear is assigned a category on its own form.
 */
export function CategoryManager({ slug, categories }: { slug: string; categories: Category[] }) {
  return (
    <Disclosure
      id="categories"
      summary={categories.length > 0 ? `Categories (${categories.length})` : "Categories"}
      hint={categories.length > 0 ? "Add, rename, order or delete" : "Group your gear: Audio, Lighting…"}
      className="bg-card"
    >
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Categories group your gear here and a proposal&apos;s add-ons, in this order. Choose an item&apos;s category on its page or when you add it.
        </p>
        {categories.length > 0 ? (
          <ol aria-label="Gear categories" className="divide-y rounded-lg border" data-testid="category-list">
            {categories.map((c, i) => (
              <CategoryRow key={c.id} slug={slug} category={c} position={i} count={categories.length} />
            ))}
          </ol>
        ) : null}
        <ActionForm action={createCategory.bind(null, slug)} submitLabel="Add category" variant="outline" inline resetOnSuccess>
          <TextField label="New category" name="name" id="new-category-name" required maxLength={CATEGORY_NAME_MAX} placeholder="Lighting" className="min-w-0 flex-1 basis-60" />
        </ActionForm>
      </div>
    </Disclosure>
  );
}

function CategoryRow({ slug, category: c, position, count }: { slug: string; category: Category; position: number; count: number }) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(task: () => Promise<ActionState>) {
    start(async () => {
      const result = await task();
      setState(result);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <li data-testid="category-row" className="grid gap-2 p-3">
      <ActionForm action={renameCategory.bind(null, slug, c.id)} submitLabel="Rename" variant="outline" inline>
        <TextField label={`Name of category ${position + 1}`} name="name" id={`category-${c.id}`} defaultValue={c.name} required maxLength={CATEGORY_NAME_MAX} className="min-w-0 flex-1 basis-48" />
      </ActionForm>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link className="text-muted-foreground underline-offset-4 hover:underline" href={`/staff/${slug}/gear?category=${c.id}`}>
          {c.items === 1 ? "1 item" : `${c.items} items`}
        </Link>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${c.name} earlier`} disabled={pending || position === 0} onClick={() => run(() => moveCategory(slug, c.id, "earlier"))}>
          <ArrowUp aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${c.name} later`} disabled={pending || position === count - 1} onClick={() => run(() => moveCategory(slug, c.id, "later"))}>
          <ArrowDown aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            const effect = c.items > 0 ? ` Its ${c.items === 1 ? "item becomes" : `${c.items} items become`} uncategorized; nothing else changes.` : "";
            if (window.confirm(`Delete the category “${c.name}”?${effect}`)) run(() => deleteCategory(slug, c.id));
          }}
        >
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>
      <FormMessage state={state} />
    </li>
  );
}
