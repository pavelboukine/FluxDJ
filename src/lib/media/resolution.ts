/**
 * Photo resolution policy for new gear and package photos, from the sizes
 * proposals show them at (lib/proposals/media serves 400 to 1600 pixels):
 *
 *  - Cards are at most about 400 CSS pixels wide in a 4:3 frame, so a photo
 *    needs about 400 x 300 pixels not to look soft even there. Smaller photos
 *    are refused.
 *  - The full-screen viewer shows up to 1600 pixels. Below 1200 pixels on the
 *    long side a photo is accepted, with a warning that it may look blurry
 *    when enlarged.
 *
 * Sides are measured as displayed (EXIF orientation applied). Any aspect
 * ratio is accepted. Only new uploads are checked; existing photos are never
 * re-validated. The browser checks first for quick feedback; the server's
 * check (verify-upload.server) is the one that counts.
 */
export const PHOTO_MIN_LONG_SIDE = 400;
export const PHOTO_MIN_SHORT_SIDE = 300;
export const PHOTO_SHARP_LONG_SIDE = 1200;
export const PHOTO_RECOMMENDED_LONG_SIDE = 1600;

export type PhotoResolution = "too_small" | "low" | "ok";

export function photoResolution(width: number, height: number): PhotoResolution {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!(long >= PHOTO_MIN_LONG_SIDE && short >= PHOTO_MIN_SHORT_SIDE)) return "too_small";
  return long < PHOTO_SHARP_LONG_SIDE ? "low" : "ok";
}

/** The hint shown next to photo upload controls. */
export const PHOTO_SIZE_HINT = `Best at ${PHOTO_RECOMMENDED_LONG_SIDE} pixels or more on the long side; at least ${PHOTO_MIN_LONG_SIDE} × ${PHOTO_MIN_SHORT_SIDE}. Any shape works.`;

export function photoTooSmallMessage(width: number, height: number): string {
  return `This photo is too small (${width} × ${height} pixels). Choose a higher-resolution photo, at least ${PHOTO_MIN_LONG_SIDE} × ${PHOTO_MIN_SHORT_SIDE} pixels.`;
}

export function photoLowResolutionMessage(width: number, height: number): string {
  return `This photo (${width} × ${height} pixels) may appear blurry when enlarged. For a sharp full-screen view, use one at least ${PHOTO_RECOMMENDED_LONG_SIDE} pixels on the long side.`;
}

/**
 * The displayed size of an image file chosen in the browser, or null when the
 * browser can't decode it (the server then decides).
 */
export function readImageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (size: { width: number; height: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(size);
    };
    img.onload = () => done(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}
