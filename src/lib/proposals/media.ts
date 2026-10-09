import { KEY_PATTERN, type OfferSnapshot } from "@/lib/pricing";

/**
 * Proposal media addressing, shared by the browser and the media routes.
 *
 * Browsers never see storage paths or signed URLs for photos. A photo is
 * addressed by its position in the frozen offer, `{base}/{gearKey}/{index}`,
 * where `base` is the proposal's own media route:
 *
 *   client: /{slug}/proposals/{proposalId}/media   (proposal session cookie)
 *   staff:  /staff/{slug}/proposals/{proposalId}/media   (staff sign-in)
 *
 * The route re-authorizes every request, then resolves the storage path from
 * the frozen offer, so a URL can never name an arbitrary file, and an open
 * page keeps working for as long as its access does (no expiring links).
 *
 * Images are served resized to one of IMAGE_WIDTHS (never enlarged), as WebP.
 * Videos redirect to a short-lived signed URL of the original, issued only
 * when the viewer presses play.
 */
export const IMAGE_WIDTHS = [400, 800, 1200, 1600] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export type MediaItem = OfferSnapshot["gear"][string]["media"][number];

export function mediaPath(base: string, gearKey: string, index: number, width?: ImageWidth): string {
  return `${base}/${gearKey}/${index}${width ? `?w=${width}` : ""}`;
}

/** `srcset` for an image: every allowed width, so the browser downloads only the size it needs. */
export function mediaSrcSet(base: string, gearKey: string, index: number): string {
  return IMAGE_WIDTHS.map((w) => `${mediaPath(base, gearKey, index, w)} ${w}w`).join(", ");
}

/** Validates route parameters. Returns null for anything that is not a well-formed media reference. */
export function parseMediaRequest(gearKey: string, index: string, width: string | null): { gearKey: string; index: number; width: ImageWidth } | null {
  if (!KEY_PATTERN.test(gearKey) || !/^(0|[1-9][0-9]?)$/.test(index)) return null;
  const w = width === null ? 800 : Number(width);
  if (!(IMAGE_WIDTHS as readonly number[]).includes(w)) return null;
  return { gearKey, index: Number(index), width: w as ImageWidth };
}

/** The offer's media item at a position, if the offer has one there. */
export function offerMedia(offer: OfferSnapshot, gearKey: string, index: number): MediaItem | null {
  if (!Object.hasOwn(offer.gear, gearKey)) return null;
  return offer.gear[gearKey].media[index] ?? null;
}

/**
 * Lead media for a gear item: its first photo in the frozen media order
 * (the catalog's sort order, then storage path), or its first video when it
 * has no photos. Returns the index into the item's media list, or -1.
 */
export function leadMediaIndex(media: readonly MediaItem[]): number {
  const image = media.findIndex((m) => m.kind === "image");
  return image >= 0 ? image : media.length > 0 ? 0 : -1;
}

/**
 * Lead photo for a package: the first photo of the first included gear item
 * that has a photo, in the frozen offer's included order (the snapshot
 * stores included gear ordered by gear key). Packages have no photos of
 * their own, so this never invents one; null when none qualifies.
 */
export function packageLeadMedia(offer: OfferSnapshot, packageKey: string): { gearKey: string; index: number } | null {
  const pkg = offer.packages.find((p) => p.key === packageKey);
  for (const item of pkg?.included ?? []) {
    const index = offer.gear[item.gear_key]?.media.findIndex((m) => m.kind === "image") ?? -1;
    if (index >= 0) return { gearKey: item.gear_key, index };
  }
  return null;
}
