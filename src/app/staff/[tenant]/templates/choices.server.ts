import "server-only";
import type { StaffContext } from "@/lib/auth/staff";
import { includedGearSummary } from "@/lib/lists";

/** Choices offered in the template editor, at most this many of each. */
export const CHOICES_LIMIT = 300;

export type PackageChoice = {
  id: string;
  name: string;
  active: boolean;
  basePriceCents: number;
  /** "Includes Main system, 2 × Wireless mic". */
  gearSummary: string;
  archivedGear: number;
  taxCategory: string;
  /** Tax categories of its included gear. */
  gearTaxCategories: string[];
};

export type QuestionChoice = { id: string; prompt: string; answerType: string; required: boolean; active: boolean; activeRules: number };

/**
 * Packages and questions a template can use: every active one (bounded),
 * plus the given ids even when archived, so what a template already has is
 * shown (and flagged) instead of silently dropped.
 */
export async function loadTemplateChoices({ supabase, tenant }: StaffContext, selected: { packageIds: string[]; questionIds: string[] }) {
  const pkgSelect = "id, name, active, base_price_cents, tax_category, sort_order, package_items(quantity, gear_items!package_items_gear_item_fk(name, active, tax_category))";
  const qSelect = "id, prompt, answer_type, required, active, sort_order, logistics_rules(active)";
  const [activePkgs, selectedPkgs, activeQs, selectedQs] = await Promise.all([
    supabase.from("packages").select(pkgSelect).eq("tenant_id", tenant.id).eq("active", true).order("sort_order").order("name").limit(CHOICES_LIMIT),
    selected.packageIds.length ? supabase.from("packages").select(pkgSelect).eq("tenant_id", tenant.id).in("id", selected.packageIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("logistics_questions").select(qSelect).eq("tenant_id", tenant.id).eq("active", true).order("sort_order").order("prompt").limit(CHOICES_LIMIT),
    selected.questionIds.length ? supabase.from("logistics_questions").select(qSelect).eq("tenant_id", tenant.id).in("id", selected.questionIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (activePkgs.error || selectedPkgs.error || activeQs.error || selectedQs.error) throw new Error("The catalog couldn't be loaded.");

  const pkgRows = new Map<string, NonNullable<typeof activePkgs.data>[number]>();
  for (const p of [...(activePkgs.data ?? []), ...(selectedPkgs.data ?? [])]) pkgRows.set(p.id, p);
  const packages: PackageChoice[] = [...pkgRows.values()]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((p) => {
      const items = p.package_items.flatMap((i) => (i.gear_items ? [{ name: i.gear_items.name, quantity: i.quantity, active: i.gear_items.active }] : []));
      return {
        id: p.id,
        name: p.name,
        active: p.active,
        basePriceCents: p.base_price_cents,
        gearSummary: includedGearSummary(items),
        archivedGear: items.filter((i) => !i.active).length,
        taxCategory: p.tax_category,
        gearTaxCategories: [...new Set(p.package_items.flatMap((i) => (i.gear_items ? [i.gear_items.tax_category] : [])))],
      };
    });

  const qRows = new Map<string, NonNullable<typeof activeQs.data>[number]>();
  for (const q of [...(activeQs.data ?? []), ...(selectedQs.data ?? [])]) qRows.set(q.id, q);
  const questions: QuestionChoice[] = [...qRows.values()]
    .sort((a, b) => a.sort_order - b.sort_order || a.prompt.localeCompare(b.prompt))
    .map((q) => ({ id: q.id, prompt: q.prompt, answerType: q.answer_type, required: q.required, active: q.active, activeRules: q.logistics_rules.filter((r) => r.active).length }));

  return { packages, questions, capped: (activePkgs.data?.length ?? 0) >= CHOICES_LIMIT || (activeQs.data?.length ?? 0) >= CHOICES_LIMIT };
}
