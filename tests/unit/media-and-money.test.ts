import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { photoResolution } from "@/lib/media/resolution";
import { sniffMediaType } from "@/lib/media/sniff";
import { checkPhoto } from "@/lib/media/verify-upload.server";
import { centsToInputValue, formatCents, parseMoneyToCents } from "@/lib/money";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  return bytes([0, 0, 0, size], "ftyp", major, [0, 0, 0, 0], ...compatible);
};

describe("sniffMediaType", () => {
  it.each([
    ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["PNG", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["WebP", bytes("RIFF", [0, 0, 0, 0], "WEBP"), "image/webp"],
    ["AVIF", ftyp("avif", "mif1"), "image/avif"],
    ["AVIF via mif1", ftyp("mif1", "avif"), "image/avif"],
    ["MP4 (isom)", ftyp("isom", "iso2", "mp41"), "video/mp4"],
    ["MP4 (mp42)", ftyp("mp42"), "video/mp4"],
    ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"), "video/webm"],
  ])("detects %s", (_label, input, expected) => {
    expect(sniffMediaType(input)).toBe(expected);
  });

  it.each([
    ["HTML", bytes("<!doctype html><script>")],
    ["SVG", bytes("<svg xmlns='http://www.w3.org/2000/svg'>")],
    ["PDF", bytes("%PDF-1.7")],
    ["QuickTime", ftyp("qt  ")],
    ["HEIC", ftyp("heic", "mif1")],
    ["Matroska (not WebM)", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], "matroska")],
    ["GIF", bytes("GIF89a")],
    ["empty", new Uint8Array()],
    ["truncated JPEG", bytes([0xff, 0xd8])],
  ])("rejects %s", (_label, input) => {
    expect(sniffMediaType(input)).toBeNull();
  });
});

describe("photo resolution", () => {
  it.each([
    [399, 350, "too_small"],
    [2000, 299, "too_small"],
    [400, 300, "low"],
    [300, 400, "low"],
    [1199, 900, "low"],
    [1200, 300, "ok"],
    [1600, 1200, "ok"],
    [900, 1600, "ok"],
  ] as const)("%i x %i is %s", (width, height, expected) => {
    expect(photoResolution(width, height)).toBe(expected);
  });

  it("decodes the photo, measures it as displayed (EXIF orientation) and refuses a mismatched format", async () => {
    const turned = await sharp({ create: { width: 1600, height: 350, channels: 3, background: "#123" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await checkPhoto(turned, "image/jpeg")).toMatchObject({ ok: true, width: 350, height: 1600, resolution: "ok" });
    const png = await sharp({ create: { width: 800, height: 600, channels: 4, background: "#0000" } }).png().toBuffer();
    expect(await checkPhoto(png, "image/png")).toMatchObject({ ok: true, resolution: "low" });
    expect(await checkPhoto(png, "image/jpeg")).toMatchObject({ ok: false });
    const truncated = (await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#456" } }).jpeg().toBuffer()).subarray(0, 600);
    expect(await checkPhoto(truncated, "image/jpeg")).toMatchObject({ ok: false });
  });
});

describe("money", () => {
  it.each([
    ["150", 15000],
    ["150.5", 15050],
    ["150.50", 15050],
    ["$1,500.00", 150000],
    [" 0.99 ", 99],
    ["0", 0],
  ])("parses %j to cents", (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "1.234", "-5", "1e3", "12.3.4", "0x10", "NaN"])("rejects %j", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });

  it("round-trips through the input format without floating point drift", () => {
    for (const cents of [0, 1, 99, 100, 15050, 270191, 9_999_999_99]) {
      expect(parseMoneyToCents(centsToInputValue(cents))).toBe(cents);
    }
  });

  it("formats CAD", () => {
    expect(formatCents(270191)).toBe("$2,701.91");
  });
});
