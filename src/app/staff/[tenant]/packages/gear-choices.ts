import "server-only";
import type { StaffContext } from "@/lib/auth/staff";

/** Gear offered in the package gear picker, at most this many. */
export const GEAR_CHOICES_LIMIT = 300;

export type GearChoice = { id: string; name: string; unitLabel: string; active: boolean; thumbUrl: string | null };

/**
 * Gear a package can include: every active item (by name, bounded), plus the
 * given ids even when archived (gear already included stays visible, never
 * silently dropped). Each has its first active photo as a short-lived signed
 * thumbnail, as on the gear list.
 */
export async function loadGearChoices({ supabase, tenant }: StaffContext, includedIds: string[]): Promise<{ choices: GearChoice[]; capped: boolean }> {
  // Each item with its first active photo only.
  const base = () =>
    supabase
      .from("gear_items")
      .select("id, name, unit_label, active, thumb:gear_media(storage_path)")
      .eq("tenant_id", tenant.id)
      .eq("thumb.active", true)
      .eq("thumb.kind", "image")
      .order("sort_order", { referencedTable: "thumb" })
      .order("created_at", { referencedTable: "thumb" })
      .limit(1, { referencedTable: "thumb" })
      .order("name");
  const [active, included] = await Promise.all([
    base().eq("active", true).limit(GEAR_CHOICES_LIMIT),
    includedIds.length ? base().in("id", includedIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (active.error || included.error) throw new Error("The gear catalog couldn't be loaded.");
  const rows = new Map<string, (typeof active.data)[number]>();
  for (const g of [...(included.data ?? []), ...(active.data ?? [])]) rows.set(g.id, g);
  const paths = [...rows.values()].flatMap((g) => g.thumb.map((t) => t.storage_path));
  const { data: signed } = paths.length
    ? await supabase.storage.from("gear-media").createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const choices = [...rows.values()]
    .map((g) => ({ id: g.id, name: g.name, unitLabel: g.unit_label, active: g.active, thumbUrl: g.thumb[0] ? (urlFor.get(g.thumb[0].storage_path) ?? null) : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { choices, capped: (active.data?.length ?? 0) >= GEAR_CHOICES_LIMIT };
}
