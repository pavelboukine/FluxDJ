/**
 * Server-side media type detection from file content ("magic bytes").
 * The browser's declared type and the file extension are never trusted on
 * their own: an upload is accepted only if its first bytes match one of the
 * allowed formats AND agree with the declared type.
 */

export const GEAR_MEDIA_TYPES = {
  "image/jpeg": { kind: "image", extension: "jpg", maxBytes: 15 * 1024 * 1024 },
  "image/png": { kind: "image", extension: "png", maxBytes: 15 * 1024 * 1024 },
  "image/webp": { kind: "image", extension: "webp", maxBytes: 15 * 1024 * 1024 },
  "image/avif": { kind: "image", extension: "avif", maxBytes: 15 * 1024 * 1024 },
  "video/mp4": { kind: "video", extension: "mp4", maxBytes: 100 * 1024 * 1024 },
  "video/webm": { kind: "video", extension: "webm", maxBytes: 100 * 1024 * 1024 },
} as const;

export type GearMediaType = keyof typeof GEAR_MEDIA_TYPES;

/** How many leading bytes sniffing needs. */
export const SNIFF_BYTES = 4096;

export function isGearMediaType(value: string): value is GearMediaType {
  return Object.hasOwn(GEAR_MEDIA_TYPES, value);
}

const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4", "MSNV"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

/** Returns the detected allowed type, or null if the content is not an allowed format. */
export function sniffMediaType(bytes: Uint8Array): GearMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  // ISO base media file format: [size]["ftyp"][major brand][minor][compatible brands...]
  if (ascii(bytes, 4, 4) === "ftyp") {
    const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(boxSize >= 16 ? boxSize : 16, bytes.length);
    const major = ascii(bytes, 8, 4);
    const compatible: string[] = [];
    for (let offset = 16; offset + 4 <= end; offset += 4) compatible.push(ascii(bytes, offset, 4));
    if (AVIF_BRANDS.has(major) || (major === "mif1" && compatible.some((b) => AVIF_BRANDS.has(b)))) return "image/avif";
    if (MP4_BRANDS.has(major)) return "video/mp4";
    return null; // QuickTime, HEIC, 3GP and other ISO formats are not accepted.
  }

  // Matroska/EBML header with a "webm" DocType.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = ascii(bytes, 0, Math.min(bytes.length, 64));
    return head.includes("webm") ? "video/webm" : null;
  }
  return null;
}
