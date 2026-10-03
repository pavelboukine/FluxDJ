import { describe, expect, it } from "vitest";
import { sniffMediaType } from "@/lib/media/sniff";
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
