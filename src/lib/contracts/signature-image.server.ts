import "server-only";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { SIGNATURE_LIMITS } from "./signing";

/**
 * Validates a drawn signature and re-encodes it as a clean PNG.
 *
 * Only plain, non-interlaced, 8-bit PNG (greyscale, RGB, greyscale+alpha or
 * RGBA) is accepted: no palettes, no SVG, no other formats. Chunk CRCs are
 * checked, unknown critical chunks and trailing bytes are refused, and the
 * pixel data is inflated with an exact size cap (no decompression bombs).
 * The output is rebuilt from the decoded pixels (IHDR, one IDAT, IEND), so
 * nothing from the upload except pixels is ever stored.
 *
 * "Meaningful" content: enough dark, opaque ink pixels spread over a
 * minimum area, and not a filled block.
 */

export type SignatureImage = { png: Buffer; sha256: string; width: number; height: number; inkPixels: number };
export type SignatureImageError = { code: "malformed" | "too_large" | "dimensions" | "blank"; message: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const MIN_INK_PIXELS = 200;
const MIN_INK_SPAN = { width: 80, height: 40 };
const MAX_INK_RATIO = 0.5;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const fail = (code: SignatureImageError["code"], message: string): { ok: false; error: SignatureImageError } => ({ ok: false, error: { code, message } });

/** Decodes a data URL from the signing panel. */
export function decodeSignatureDataUrl(value: unknown): { ok: true; bytes: Buffer } | { ok: false; error: SignatureImageError } {
  if (typeof value !== "string") return fail("malformed", "Draw your signature again.");
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix)) return fail("malformed", "Your signature must be a drawn image. Draw it again.");
  const base64 = value.slice(prefix.length);
  if (base64.length > Math.ceil(SIGNATURE_LIMITS.maxBytes / 3) * 4) return fail("too_large", "Your signature image is too large. Clear it and draw it again.");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) return fail("malformed", "Draw your signature again.");
  return { ok: true, bytes: Buffer.from(base64, "base64") };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function processSignatureImage(input: Buffer): { ok: true; image: SignatureImage } | { ok: false; error: SignatureImageError } {
  if (input.length > SIGNATURE_LIMITS.maxBytes) return fail("too_large", "Your signature image is too large. Clear it and draw it again.");
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return fail("malformed", "Your signature must be a drawn image. Draw it again.");

  let offset = 8;
  let header: { width: number; height: number; colorType: number } | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < input.length) {
    if (ended || offset + 12 > input.length) return fail("malformed", "Draw your signature again.");
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8);
    const typeName = type.toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(typeName) || offset + 12 + length > input.length) return fail("malformed", "Draw your signature again.");
    const data = input.subarray(offset + 8, offset + 8 + length);
    if (input.readUInt32BE(offset + 8 + length) !== crc32(type, data)) return fail("malformed", "Draw your signature again.");
    offset += 12 + length;

    if (typeName === "IHDR") {
      if (header || length !== 13 || idat.length) return fail("malformed", "Draw your signature again.");
      const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13);
      if (bitDepth !== 8 || !(colorType in CHANNELS) || compression !== 0 || filter !== 0 || interlace !== 0) {
        return fail("malformed", "Your signature must be a drawn image. Draw it again.");
      }
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType };
    } else if (!header) {
      return fail("malformed", "Draw your signature again.");
    } else if (typeName === "IDAT") {
      idat.push(data);
    } else if (typeName === "IEND") {
      ended = true;
    } else if (typeName[0] === typeName[0].toUpperCase()) {
      // Unknown critical chunk (including PLTE: palettes are not accepted).
      return fail("malformed", "Your signature must be a drawn image. Draw it again.");
    }
    // Ancillary chunks (text, colour profiles, ...) are ignored and dropped.
  }
  if (!header || !ended || idat.length === 0) return fail("malformed", "Draw your signature again.");

  const { width, height, colorType } = header;
  if (width < SIGNATURE_LIMITS.minWidth || width > SIGNATURE_LIMITS.maxWidth || height < SIGNATURE_LIMITS.minHeight || height > SIGNATURE_LIMITS.maxHeight) {
    return fail("dimensions", "Your signature image has an unexpected size. Clear it and draw it again.");
  }
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    return fail("malformed", "Draw your signature again.");
  }
  if (raw.length !== expected) return fail("malformed", "Draw your signature again.");

  // Unfilter into RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value: number;
      switch (filterType) {
        case 0: value = line[i]; break;
        case 1: value = line[i] + left; break;
        case 2: value = line[i] + up; break;
        case 3: value = line[i] + ((left + up) >> 1); break;
        case 4: value = line[i] + paeth(left, up, upLeft); break;
        default: return fail("malformed", "Draw your signature again.");
      }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1 || channels === 2) {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = current[s];
        rgba[d + 3] = channels === 2 ? current[s + 1] : 255;
      } else {
        rgba[d] = current[s];
        rgba[d + 1] = current[s + 1];
        rgba[d + 2] = current[s + 2];
        rgba[d + 3] = channels === 4 ? current[s + 3] : 255;
      }
    }
    previous = Buffer.from(current);
  }

  // Ink: opaque and dark. An opaque white background is not ink.
  let ink = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const luminance = 0.299 * rgba[d] + 0.587 * rgba[d + 1] + 0.114 * rgba[d + 2];
      if (rgba[d + 3] >= 128 && luminance < 160) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const spanW = maxX - minX + 1;
  const spanH = maxY - minY + 1;
  if (ink < MIN_INK_PIXELS || (spanW < MIN_INK_SPAN.width && spanH < MIN_INK_SPAN.height)) {
    return fail("blank", "Your signature is empty or too small. Sign in the box with your finger, stylus or mouse.");
  }
  if (ink / (width * height) > MAX_INK_RATIO) return fail("blank", "That doesn't look like a signature. Clear it and sign again.");

  const png = encodeRgbaPng(rgba, width, height);
  if (png.length > SIGNATURE_LIMITS.maxBytes) return fail("too_large", "Your signature image is too large. Clear it and draw it again.");
  return { ok: true, image: { png, sha256: createHash("sha256").update(png).digest("hex"), width, height, inkPixels: ink } };
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBytes, data), 8 + data.length);
  return out;
}

/** A minimal, deterministic RGBA PNG (filter 0 on every row). */
export function encodeRgbaPng(rgba: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
