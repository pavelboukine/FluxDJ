"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, KEY_RE, keyFromName, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import { parseMoneyToCents } from "@/lib/money";
import { GEAR_MEDIA_TYPES, isGearMediaType } from "@/lib/media/sniff";
import { checkUploadedMedia, declaredTypeOf, discardUpload } from "@/lib/media/verify-upload.server";

function readPackageForm(form: FormData, categories: string[]) {
  const name = text(form, "name");
  const price = parseMoneyToCents(text(form, "price"));
  const taxCategory = text(form, "tax_category");
  const sortOrder = int(form, "sort_order", 0, 10000);
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Name is required (up to 200 characters)." } as const;
  if (price === null || price > 100_000_000) return { ok: false, error: "Enter a base price like 1500 or 1500.00." } as const;
  if (!taxCategory) return { ok: false, error: "Choose a tax category." } as const;
  if (!KEY_RE.test(taxCategory) || (categories.length > 0 && !categories.includes(taxCategory)))
    return { ok: false, error: "Choose a configured tax category." } as const;
  if (sortOrder === null) return { ok: false, error: "Order must be a whole number from 0 to 10000." } as const;
  return {
    ok: true,
    values: {
      name,
      description: optionalText(form, "description"),
      base_price_cents: price,
      tax_category: taxCategory,
      sort_order: sortOrder,
      // packages.is_popular is kept but no longer edited here: nothing reads it.
    },
  } as const;
}

/** Form fields "qty:<gear id>" -> included quantity (0 or empty = not included). */
function readPackageItems(form: FormData) {
  const items: { gear_item_id: string; quantity: number }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("qty:") || typeof value !== "string") continue;
    const gearId = name.slice(4);
    const raw = value.trim();
    if (raw === "" || raw === "0") continue;
    if (!UUID_RE.test(gearId) || !/^\d{1,3}$/.test(raw) || Number(raw) > 100) return { ok: false, error: "Quantities must be whole numbers from 1 to 100." } as const;
    if (items.some((i) => i.gear_item_id === gearId)) return { ok: false, error: "Each gear item can be included once; change its quantity instead." } as const;
    items.push({ gear_item_id: gearId, quantity: Number(raw) });
  }
  return { ok: true, items } as const;
}

const categoriesOf = (value: unknown) => (value && typeof value === "object" ? Object.keys(value) : []);

/**
 * Creates a package with its included gear in one step (create_package):
 * both are saved or neither is, so a failure keeps the form as typed for a
 * retry. The form's request id makes a retry after a lost response return
 * the package already created instead of creating another.
 */
export async function createPackage(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const requestId = text(form, "request_id");
  if (!UUID_RE.test(requestId)) return fail("Reload the page and try again.");
  const parsed = readPackageForm(form, categoriesOf(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  const items = readPackageItems(form);
  if (!items.ok) return fail(items.error);
  const key = text(form, "key") || keyFromName(parsed.values.name);
  if (!KEY_RE.test(key)) return fail("Key must start with a letter and use lowercase letters, digits and underscores.");
  const { data, error } = await supabase.rpc("create_package", {
    p_tenant_id: tenant.id,
    p_package_id: requestId,
    p_key: key,
    p_name: parsed.values.name,
    // Nullable in the database; the generated type doesn't say so.
    p_description: parsed.values.description as string,
    p_base_price_cents: parsed.values.base_price_cents,
    p_tax_category: parsed.values.tax_category,
    p_sort_order: parsed.values.sort_order,
    p_items: items.items,
  });
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  const result = data as { id: string; replayed: boolean };
  revalidatePath(`/staff/${slug}/packages`);
  // The form uploads a chosen photo next, then opens the package itself.
  if (text(form, "photo_pending") === "1") return ok("Package created.");
  redirect(`/staff/${slug}/packages/${result.id}?created=${result.replayed ? "replayed" : "1"}`);
}

export async function updatePackage(slug: string, packageId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readPackageForm(form, categoriesOf(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  // Archiving is its own confirmed action (setPackageArchived); saving details never changes it.
  const { data, error } = await supabase
    .from("packages")
    .update(parsed.values)
    .eq("id", packageId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Package not found.");
  revalidatePath(`/staff/${slug}/packages`, "layout");
  return ok("Package saved.");
}

export async function savePackageItems(slug: string, packageId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(packageId)) return fail("Package not found.");
  const items = readPackageItems(form);
  if (!items.ok) return fail(items.error);
  const { error } = await supabase.rpc("set_package_items", { p_package_id: packageId, p_items: items.items });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/packages`, "layout");
  return ok("Included gear saved.");
}

/**
 * Archives or restores a package through set_package_archived (staff of the
 * business; audited; a repeat is a no-op). Only the package's active flag
 * changes: included gear, templates and proposals are untouched.
 */
export async function setPackageArchived(slug: string, packageId: string, archived: boolean): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(packageId)) return fail("Package not found.");
  const { data, error } = await supabase.rpc("set_package_archived", { p_package_id: packageId, p_archived: archived });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}`, "layout");
  const result = data as { replayed?: boolean };
  if (result.replayed) return ok(archived ? "This package was already archived." : "This package was already active.");
  return ok(archived ? "Package archived." : "Package restored.");
}

// ---------------------------------------------------------------------------
// Package photo
//
// The gear media upload flow (see gear/actions.ts), for one image per
// package: the server picks the path ({tenant}/packages/{package}/uuid.ext),
// the browser uploads to Storage (RLS: own business, existing package only),
// then the content is verified before set_package_photo points the package
// at it. Replacing or removing archives the previous photo's record and keeps
// its file, so proposals already sent still show it.
// ---------------------------------------------------------------------------

export type PreparePhotoResult = { ok: true; path: string } | { ok: false; message: string };

const PHOTO_TYPES = "Upload a JPEG, PNG, WebP or AVIF photo.";

export async function preparePackagePhotoUpload(slug: string, packageId: string, file: { contentType: string; size: number }): Promise<PreparePhotoResult> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(packageId)) return { ok: false, message: "Package not found." };
  if (!isGearMediaType(file.contentType) || GEAR_MEDIA_TYPES[file.contentType].kind !== "image") return { ok: false, message: PHOTO_TYPES };
  const spec = GEAR_MEDIA_TYPES[file.contentType];
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > spec.maxBytes) {
    return { ok: false, message: `That file is too large. Photos can be up to ${spec.maxBytes / 1024 / 1024} MB.` };
  }
  const { data: pkg } = await supabase.from("packages").select("id").eq("id", packageId).eq("tenant_id", tenant.id).maybeSingle();
  if (!pkg) return { ok: false, message: "Package not found." };
  return { ok: true, path: `${tenant.id}/packages/${packageId}/${randomUUID()}.${spec.extension}` };
}

/** Verifies an uploaded photo and makes it the package's photo (the previous one is archived, not deleted). */
export async function finalizePackagePhotoUpload(slug: string, packageId: string, input: { path: string; altText: string }): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const pathPattern = new RegExp(`^${tenant.id}/packages/${packageId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp|avif)$`);
  if (!UUID_RE.test(packageId) || !pathPattern.test(input.path)) return fail("Invalid upload.");
  const declared = declaredTypeOf(input.path)!;
  const reject = async (message: string) => {
    await discardUpload(input.path);
    return fail(message);
  };

  const { data: pkg } = await supabase.from("packages").select("name").eq("id", packageId).eq("tenant_id", tenant.id).maybeSingle();
  if (!pkg) return reject("Package not found.");
  // A description is optional here: the package name describes the photo well enough.
  const altText = input.altText.trim() || pkg.name;
  if (altText.length > 300) return reject("The description can be up to 300 characters.");

  const checked = await checkUploadedMedia(supabase, input.path, declared);
  if (!checked.ok) return checked.discard ? reject(checked.message) : fail(checked.message);
  if (GEAR_MEDIA_TYPES[checked.type].kind !== "image") return reject(PHOTO_TYPES);

  const { error } = await supabase.rpc("set_package_photo", {
    p_package_id: packageId,
    p_storage_path: input.path,
    p_content_type: checked.type,
    p_alt_text: altText,
  });
  if (error) return reject(describeDbError(error));
  revalidatePath(`/staff/${slug}/packages`, "layout");
  return ok("Photo saved. It appears on new proposals.");
}

/** Removes the package's photo from new proposals. The file is kept for proposals already sent. */
export async function removePackagePhoto(slug: string, packageId: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(packageId)) return fail("Package not found.");
  // Null removes; the generated type doesn't say it's nullable.
  const { data, error } = await supabase.rpc("set_package_photo", { p_package_id: packageId, p_storage_path: null as unknown as string });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/packages`, "layout");
  return ok((data as { replayed?: boolean }).replayed ? "This package has no photo." : "Photo removed from new proposals. Proposals already sent keep it.");
}
