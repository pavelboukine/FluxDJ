import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSignatureDataUrl, encodeRgbaPng, processSignatureImage } from "@/lib/contracts/signature-image.server";
import { requestEvidence, trustedClientIp } from "@/lib/contracts/signing.server";
import { SIGNATURE_LIMITS } from "@/lib/contracts/signing";

const W = 900;
const H = 300;

/** A transparent canvas with dark strokes, like the signing panel exports. */
function canvas(draw: (plot: (x: number, y: number) => void) => void, width = W, height = H): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  const plot = (x: number, y: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const px = Math.round(x) + dx, py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  };
  draw(plot);
  return encodeRgbaPng(rgba, width, height);
}
const scribble = (plot: (x: number, y: number) => void) => {
  for (let t = 0; t < 600; t++) plot(150 + t, 150 + Math.sin(t / 20) * 60);
};
const signature = () => canvas(scribble);

/** Rebuilds a PNG from chunks (computing CRCs) for malformed-input tests. */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(CRC(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(width: number, height: number, depth = 8, color = 6, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); b[8] = depth; b[9] = color; b[12] = interlace;
  return chunk("IHDR", b);
}
const iend = () => chunk("IEND", Buffer.alloc(0));
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
const errorCode = (b: Buffer) => { const r = processSignatureImage(b); return r.ok ? "ok" : r.error.code; };

describe("processSignatureImage", () => {
  it("accepts a drawn signature and re-encodes it deterministically", () => {
    const input = signature();
    const result = processSignatureImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image).toMatchObject({ width: W, height: H });
    expect(result.image.inkPixels).toBeGreaterThan(200);
    expect(result.image.sha256).toBe(createHash("sha256").update(result.image.png).digest("hex"));
    const again = processSignatureImage(result.image.png);
    expect(again.ok && again.image.sha256).toBe(result.image.sha256);
  });

  it("drops everything except pixels (text chunks, trailing scripts)", () => {
    const base = signature();
    const withText = Buffer.concat([base.subarray(0, base.length - 12), chunk("tEXt", Buffer.from("Comment\0<script>alert(1)</script>")), iend()]);
    const result = processSignatureImage(withText);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.png.toString("latin1")).not.toContain("script");
  });

  it("accepts an opaque white background with dark ink (RGB)", () => {
    const rgb = Buffer.alloc(W * H * 3, 255);
    for (let x = 100; x < 700; x++) for (let y = 140; y < 144; y++) rgb.fill(20, (y * W + x) * 3, (y * W + x) * 3 + 3);
    const raw = Buffer.alloc(H * (W * 3 + 1));
    for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
    const png = Buffer.concat([SIG, ihdr(W, H, 8, 2), chunk("IDAT", deflateSync(raw)), iend()]);
    expect(errorCode(png)).toBe("ok");
  });

  it.each([
    ["an empty canvas", () => canvas(() => {})],
    ["a single dot", () => canvas((plot) => plot(400, 150))],
    ["a tiny mark", () => canvas((plot) => { for (let t = 0; t < 20; t++) plot(400 + t, 150); })],
    ["a white-only drawing", () => encodeRgbaPng(Buffer.alloc(W * H * 4, 255), W, H)],
  ])("rejects %s as blank", (_label, make) => {
    expect(errorCode(make())).toBe("blank");
  });

  it("rejects a filled block (not a signature)", () => {
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4 + 3] = 255; }
    expect(errorCode(encodeRgbaPng(rgba, W, H))).toBe("blank");
  });

  it("rejects dimensions outside the expected range", () => {
    expect(errorCode(canvas(scribble, 200, 300))).toBe("dimensions");
    expect(errorCode(canvas((plot) => { for (let t = 0; t < 1500; t++) plot(100 + t, 100); }, 2000, 300))).toBe("dimensions");
    expect(errorCode(canvas(scribble, 900, 50))).toBe("dimensions");
  });

  it("rejects oversized input before decoding", () => {
    expect(errorCode(Buffer.concat([signature(), Buffer.alloc(SIGNATURE_LIMITS.maxBytes)]))).toBe("too_large");
  });

  it.each([
    ["not a PNG (JPEG)", () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])],
    ["SVG markup", () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["a bad chunk CRC", () => { const b = Buffer.from(signature()); b[b.length - 20] ^= 0xff; return b; }],
    ["bytes after IEND", () => Buffer.concat([signature(), Buffer.from("<script>")])],
    ["a missing IEND", () => { const b = signature(); return b.subarray(0, b.length - 12); }],
    ["a palette image", () => Buffer.concat([SIG, ihdr(W, H, 8, 3), chunk("PLTE", Buffer.alloc(6)), chunk("IDAT", deflateSync(Buffer.alloc(H * (W + 1)))), iend()])],
    ["16-bit depth", () => Buffer.concat([SIG, ihdr(W, H, 16, 6), chunk("IDAT", deflateSync(Buffer.alloc(10))), iend()])],
    ["interlacing", () => Buffer.concat([SIG, ihdr(W, H, 8, 6, 1), chunk("IDAT", deflateSync(Buffer.alloc(10))), iend()])],
    ["truncated pixel data", () => Buffer.concat([SIG, ihdr(W, H), chunk("IDAT", deflateSync(Buffer.alloc(1000))), iend()])],
    ["a decompression bomb", () => Buffer.concat([SIG, ihdr(W, H), chunk("IDAT", deflateSync(Buffer.alloc(50 * 1024 * 1024))), iend()])],
    ["an unknown critical chunk", () => { const b = signature(); return Buffer.concat([b.subarray(0, b.length - 12), chunk("ABCD", Buffer.alloc(4)), iend()]); }],
    ["a bad filter type", () => { const raw = Buffer.alloc(H * (W * 4 + 1)); raw[0] = 9; return Buffer.concat([SIG, ihdr(W, H), chunk("IDAT", deflateSync(raw)), iend()]); }],
  ])("rejects %s as malformed", (_label, make) => {
    expect(["malformed", "too_large"]).toContain(errorCode(make()));
  });
});

describe("decodeSignatureDataUrl", () => {
  it("accepts only base64 PNG data URLs", () => {
    expect(decodeSignatureDataUrl(dataUrl(signature())).ok).toBe(true);
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/png,rawtext",
      "data:image/png;base64,***",
      "https://example.test/sig.png",
      42,
      null,
    ]) {
      expect(decodeSignatureDataUrl(bad).ok).toBe(false);
    }
  });

  it("refuses oversized data URLs before decoding", () => {
    const huge = `data:image/png;base64,${"A".repeat(Math.ceil(SIGNATURE_LIMITS.maxBytes / 3) * 4 + 4)}`;
    const result = decodeSignatureDataUrl(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_large");
  });
});

describe("request evidence", () => {
  const h = (entries: Record<string, string>) => new Headers(entries);

  it("trusts the IP only from Vercel's own header when running on Vercel", () => {
    expect(trustedClientIp(h({ "x-vercel-forwarded-for": "203.0.113.7" }), { VERCEL: "1" })).toEqual({ ip: "203.0.113.7", ipSource: "vercel" });
    expect(trustedClientIp(h({ "x-vercel-forwarded-for": "2001:db8::1" }), { VERCEL: "1" })).toEqual({ ip: "2001:db8::1", ipSource: "vercel" });
  });

  it("records the IP as unavailable rather than trusting spoofable headers", () => {
    // Local development or another host: generic proxy headers are ignored.
    expect(trustedClientIp(h({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.1", "x-vercel-forwarded-for": "198.51.100.1" }), {})).toEqual({ ip: null, ipSource: "unavailable" });
    // On Vercel, only x-vercel-forwarded-for counts, and it must be an IP.
    expect(trustedClientIp(h({ "x-forwarded-for": "198.51.100.1" }), { VERCEL: "1" })).toEqual({ ip: null, ipSource: "unavailable" });
    expect(trustedClientIp(h({ "x-vercel-forwarded-for": "not-an-ip" }), { VERCEL: "1" })).toEqual({ ip: null, ipSource: "unavailable" });
  });

  it("bounds the user agent and omits a missing one", () => {
    expect(requestEvidence(h({ "user-agent": "x".repeat(900) }), {}).userAgent).toHaveLength(512);
    expect(requestEvidence(h({}), {}).userAgent).toBeNull();
  });
});
