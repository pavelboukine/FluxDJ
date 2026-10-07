"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeDbError } from "@/lib/db-errors";
import { fail, KEY_RE, keyFromName, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import { parseMoneyToCents } from "@/lib/money";
import { GEAR_MEDIA_TYPES, isGearMediaType, SNIFF_BYTES, sniffMediaType, type GearMediaType } from "@/lib/media/sniff";

const BUCKET = "gear-media";
/** More media than this on one item is not reordered (sort_order allows 0–10000). */
const MAX_MEDIA_ORDER = 200;

function taxCategories(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function readGearForm(form: FormData, categories: string[]) {
  const name = text(form, "name");
  const price = parseMoneyToCents(text(form, "price"));
  const taxCategory = text(form, "tax_category");
  const unitLabel = text(form, "unit_label") || "unit";
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Name is required (up to 200 characters)." } as const;
  if (price === null || price > 100_000_000) return { ok: false, error: "Enter a price like 150 or 150.00." } as const;
  if (!taxCategory) return { ok: false, error: "Choose a tax category." } as const;
  if (!KEY_RE.test(taxCategory) || (categories.length > 0 && !categories.includes(taxCategory)))
    return { ok: false, error: "Choose a configured tax category." } as const;
  if (unitLabel.length > 40) return { ok: false, error: "Unit label is too long." } as const;
  return {
    ok: true,
    values: {
      name,
      description: optionalText(form, "description"),
      unit_label: unitLabel,
      default_price_cents: price,
      tax_category: taxCategory,
    },
  } as const;
}

export async function createGear(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readGearForm(form, taxCategories(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  const key = text(form, "key") || keyFromName(parsed.values.name);
  if (!KEY_RE.test(key)) return fail("Key must start with a letter and use lowercase letters, digits and underscores.");

  const { data, error } = await supabase
    .from("gear_items")
    .insert({ ...parsed.values, key, tenant_id: tenant.id })
    .select("id")
    .single();
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/gear`);
  redirect(`/staff/${slug}/gear/${data.id}?created=1`);
}

export async function updateGear(slug: string, gearId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const parsed = readGearForm(form, taxCategories(tenant.tax_categories));
  if (!parsed.ok) return fail(parsed.error);
  // Archiving is its own confirmed action (setGearActive); saving details never changes it.
  const { data, error } = await supabase
    .from("gear_items")
    .update(parsed.values)
    .eq("id", gearId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Gear item not found.");
  revalidatePath(`/staff/${slug}/gear`, "layout");
  return ok("Gear item saved.");
}

/**
 * Archives (hides from new proposals) or restores a gear item. Nothing is
 * deleted; packages, add-ons and rules keep their links, and offers already
 * frozen keep their own copy.
 */
export async function setGearActive(slug: string, gearId: string, active: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(gearId)) return fail("Gear item not found.");
  const { data, error } = await supabase.from("gear_items").update({ active }).eq("id", gearId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Gear item not found.");
  revalidatePath(`/staff/${slug}`, "layout");
  return ok(active ? "Gear item restored." : "Gear item archived.");
}

// ---------------------------------------------------------------------------
// Media uploads
//
// 1. prepare: the server picks the object path (tenant/gear/random uuid.ext)
//    after checking the declared type and size.
// 2. the browser uploads the file directly to Storage with the staff
//    session; Storage RLS only allows the staff's own tenant and gear item.
// 3. finalize: the server reads the object's first bytes and accepts it only
//    if the content matches an allowed format AND the declared type, and the
//    size is within limits. Rejected objects are deleted. Only then is a
//    gear_media row created, so offers can never reference unvalidated files.
// ---------------------------------------------------------------------------

export type PrepareResult = { ok: true; path: string } | { ok: false; message: string };

export async function prepareGearMediaUpload(
  slug: string,
  gearId: string,
  file: { contentType: string; size: number },
): Promise<PrepareResult> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(gearId)) return { ok: false, message: "Gear item not found." };
  if (!isGearMediaType(file.contentType)) {
    return { ok: false, message: "Upload a JPEG, PNG, WebP or AVIF image, or an MP4 or WebM video." };
  }
  const spec = GEAR_MEDIA_TYPES[file.contentType];
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > spec.maxBytes) {
    return { ok: false, message: `That file is too large. ${spec.kind === "image" ? "Images" : "Videos"} can be up to ${spec.maxBytes / 1024 / 1024} MB.` };
  }
  const { data: gear } = await supabase.from("gear_items").select("id").eq("id", gearId).eq("tenant_id", tenant.id).maybeSingle();
  if (!gear) return { ok: false, message: "Gear item not found." };
  return { ok: true, path: `${tenant.id}/gear-items/${gearId}/${randomUUID()}.${spec.extension}` };
}

export async function finalizeGearMediaUpload(
  slug: string,
  gearId: string,
  input: { path: string; altText: string },
): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const pathPattern = new RegExp(
    `^${tenant.id}/gear-items/${gearId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp|avif|mp4|webm)$`,
  );
  if (!UUID_RE.test(gearId) || !pathPattern.test(input.path)) return fail("Invalid upload.");
  const altText = input.altText.trim();

  const extension = input.path.split(".").pop();
  const declared = (Object.keys(GEAR_MEDIA_TYPES) as GearMediaType[]).find((t) => GEAR_MEDIA_TYPES[t].extension === extension)!;

  const reject = async (message: string) => {
    await createAdminClient().storage.from(BUCKET).remove([input.path]);
    return fail(message);
  };

  if (altText.length < 1 || altText.length > 300) return reject("Describe the photo or video (alt text, up to 300 characters).");

  // Read only the first bytes and the total size, through a short-lived signed
  // URL issued to the staff user (so Storage RLS still applies).
  const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(input.path, 60);
  if (signError || !signed) return fail("Upload not found. Try again.");
  const response = await fetch(signed.signedUrl, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, cache: "no-store" });
  if (!response.ok) return reject("The upload could not be read. Try again.");
  const head = new Uint8Array(await response.arrayBuffer()).subarray(0, SNIFF_BYTES);
  const totalFromRange = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
  const size = Number(totalFromRange ?? response.headers.get("content-length") ?? NaN);

  const detected = sniffMediaType(head);
  if (detected === null) return reject("That file's contents are not a supported image or video.");
  if (detected !== declared) return reject("The file's contents don't match its type. Re-export it and try again.");
  if (!Number.isFinite(size) || size > GEAR_MEDIA_TYPES[detected].maxBytes) return reject("That file is too large.");

  const { count } = await supabase.from("gear_media").select("id", { count: "exact", head: true }).eq("gear_item_id", gearId);
  const { error } = await supabase.from("gear_media").insert({
    tenant_id: tenant.id,
    gear_item_id: gearId,
    storage_path: input.path,
    kind: GEAR_MEDIA_TYPES[detected].kind,
    content_type: detected,
    alt_text: altText,
    sort_order: count ?? 0,
  });
  if (error) return reject(describeDbError(error));
  revalidatePath(`/staff/${slug}/gear/${gearId}`);
  return ok("Uploaded.");
}

export async function updateMedia(slug: string, gearId: string, mediaId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const altText = text(form, "alt_text");
  if (altText.length < 1 || altText.length > 300) return fail("Alt text is required (up to 300 characters).");
  const { data, error } = await supabase
    .from("gear_media")
    .update({ alt_text: altText })
    .eq("id", mediaId)
    .eq("gear_item_id", gearId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Media not found.");
  revalidatePath(`/staff/${slug}/gear/${gearId}`);
  return ok("Description saved.");
}

/**
 * Archives (hides from new proposals) or restores one photo or video. The
 * stored file is never removed, so offers already sent still show it.
 */
export async function setMediaActive(slug: string, gearId: string, mediaId: string, active: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(gearId) || !UUID_RE.test(mediaId)) return fail("Media not found.");
  const { data, error } = await supabase
    .from("gear_media")
    .update({ active })
    .eq("id", mediaId)
    .eq("gear_item_id", gearId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Media not found.");
  revalidatePath(`/staff/${slug}/gear/${gearId}`);
  return ok(active ? "Restored. It's shown on new proposals again." : "Archived. It's hidden from new proposals.");
}

/**
 * Moves one photo or video a place earlier or later. Order is sort_order then
 * upload time (as proposals use it); the item's media are renumbered 0, 1, 2…
 * with the two swapped, writing only rows whose number changes.
 */
export async function moveMedia(slug: string, gearId: string, mediaId: string, direction: "earlier" | "later"): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(gearId) || !UUID_RE.test(mediaId)) return fail("Media not found.");
  const { data: media, error } = await supabase
    .from("gear_media")
    .select("id, sort_order")
    .eq("gear_item_id", gearId)
    .eq("tenant_id", tenant.id)
    .order("sort_order")
    .order("created_at")
    .order("storage_path")
    .limit(MAX_MEDIA_ORDER);
  if (error) return fail(describeDbError(error));
  const ids = (media ?? []).map((m) => m.id);
  const from = ids.indexOf(mediaId);
  if (from < 0) return fail("Media not found.");
  const to = direction === "earlier" ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return ok("Already in place.");
  [ids[from], ids[to]] = [ids[to], ids[from]];
  const current = new Map((media ?? []).map((m) => [m.id, m.sort_order]));
  for (const [index, id] of ids.entries()) {
    if (current.get(id) === index) continue;
    const { error: updateError } = await supabase.from("gear_media").update({ sort_order: index }).eq("id", id).eq("tenant_id", tenant.id);
    if (updateError) return fail(describeDbError(updateError));
  }
  revalidatePath(`/staff/${slug}/gear/${gearId}`);
  return ok(direction === "earlier" ? "Moved earlier." : "Moved later.");
}
