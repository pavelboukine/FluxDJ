"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, KEY_RE, keyFromName, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import { parseMoneyToCents } from "@/lib/money";

function readPackageForm(form: FormData, categories: string[]) {
  const name = text(form, "name");
  const price = parseMoneyToCents(text(form, "price"));
  const taxCategory = text(form, "tax_category") || "standard";
  const sortOrder = int(form, "sort_order", 0, 10000);
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Name is required (up to 200 characters)." } as const;
  if (price === null || price > 100_000_000) return { ok: false, error: "Enter a base price like 1500 or 1500.00." } as const;
  if (categories.length > 0 && !categories.includes(taxCategory)) return { ok: false, error: "Choose a configured tax category." } as const;
  if (sortOrder === null) return { ok: false, error: "Order must be a whole number from 0 to 10000." } as const;
  return {
    ok: true,
    values: {
      name,
      description: optionalText(form, "description"),
      base_price_cents: price,
      tax_category: taxCategory,
      sort_order: sortOrder,
      is_popular: checkbox(form, "is_popular"),
    },
  } as const;
}

const categoriesOf = (value: unknown) => (value && typeof value === "object" ? Object.keys(value) : []);

export async function createPackage(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readPackageForm(form, categoriesOf(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  const key = text(form, "key") || keyFromName(parsed.values.name);
  if (!KEY_RE.test(key)) return fail("Key must start with a letter and use lowercase letters, digits and underscores.");
  const { data, error } = await supabase
    .from("packages")
    .insert({ ...parsed.values, key, tenant_id: tenant.id })
    .select("id")
    .single();
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/packages`);
  redirect(`/staff/${slug}/packages/${data.id}`);
}

export async function updatePackage(slug: string, packageId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readPackageForm(form, categoriesOf(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  const { data, error } = await supabase
    .from("packages")
    .update({ ...parsed.values, active: checkbox(form, "active") })
    .eq("id", packageId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Package not found.");
  revalidatePath(`/staff/${slug}/packages`);
  return ok("Saved.");
}

/** Form fields "qty:<gear id>" -> included quantity (0 or empty = not included). */
export async function savePackageItems(slug: string, packageId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const items: { gear_item_id: string; quantity: number }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("qty:") || typeof value !== "string") continue;
    const gearId = name.slice(4);
    const raw = value.trim();
    if (raw === "" || raw === "0") continue;
    if (!UUID_RE.test(gearId) || !/^\d{1,3}$/.test(raw) || Number(raw) > 100) return fail("Quantities must be whole numbers from 0 to 100.");
    items.push({ gear_item_id: gearId, quantity: Number(raw) });
  }
  const { error } = await supabase.rpc("set_package_items", { p_package_id: packageId, p_items: items });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/packages/${packageId}`);
  return ok("Included gear saved.");
}
