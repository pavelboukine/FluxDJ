/**
 * Gear categories: each business keeps its own (gear_categories). These are
 * offered as suggestions until the business creates its own; nothing is
 * created until a gear item is saved with one.
 */
export const SUGGESTED_CATEGORIES = ["Audio", "Lighting", "Special Effects", "DJ Equipment", "Other"] as const;

export const CATEGORY_NAME_MAX = 60;

/** Staff wording for gear without a category. */
export const UNCATEGORIZED = "Uncategorized";

export type CategoryRef = { name: string; sort_order: number } | null | undefined;

/** Trims and collapses spaces; null when empty or too long. */
export function normalizeCategoryName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= CATEGORY_NAME_MAX ? name : null;
}

/** Suggested names the business doesn't have yet (case-insensitive), in suggested order. */
export function missingSuggestions(existing: string[]): string[] {
  const have = new Set(existing.map((n) => n.toLowerCase()));
  return SUGGESTED_CATEGORIES.filter((n) => !have.has(n.toLowerCase()));
}

export type CategoryGroup<T> = { key: string; name: string | null; items: T[] };

/**
 * Groups items by category: categories by their order then name, items
 * keeping their given order, uncategorized items last (name null). Empty
 * categories never appear.
 */
export function groupByCategory<T>(items: T[], categoryOf: (item: T) => CategoryRef): CategoryGroup<T>[] {
  const groups = new Map<string, { group: CategoryGroup<T>; order: number }>();
  for (const item of items) {
    const c = categoryOf(item);
    const key = c ? `c:${c.name.toLowerCase()}` : "none";
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: { key, name: c?.name ?? null, items: [] }, order: c ? c.sort_order : Number.POSITIVE_INFINITY };
      groups.set(key, entry);
    }
    entry.group.items.push(item);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || (a.group.name ?? "").localeCompare(b.group.name ?? ""))
    .map((e) => e.group);
}
