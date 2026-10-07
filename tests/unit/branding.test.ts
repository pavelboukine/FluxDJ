import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { brandTheme, contrastRatio, normalizeHex } from "@/lib/branding/colors";
import { LOGO_MAX_UPLOAD_BYTES, processLogo } from "@/lib/branding/logo.server";
import { describeDbError } from "@/lib/db-errors";
import {
  animatedWebp,
  corruptPng,
  fullyTransparentPng,
  htmlDisguisedAsPng,
  opaqueJpeg,
  opaqueWebp,
  svgLogo,
  transparentPng,
  whiteOnTransparentPng,
} from "../support/logo-fixtures";

describe("brand colours", () => {
  it("accepts only #rrggbb and normalizes case", () => {
    expect(normalizeHex("#1A2B3C")).toBe("#1a2b3c");
    for (const bad of ["1a2b3c", "#abc", "#12345g", "red", "#1a2b3c; color: red", "", null, 42]) expect(normalizeHex(bad)).toBeNull();
  });

  it("always picks readable button text (at least 4.5:1) and falls back to the default colour", () => {
    for (const color of ["#ffffff", "#ffff00", "#777777", "#757575", "#767676", "#7a7a7a", "#808080", "#e11d48", "#000000", "#0ea5e9", "#22c55e"]) {
      const theme = brandTheme(color);
      expect(theme.foregroundContrast).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.color, theme.foreground)).toBeCloseTo(theme.foregroundContrast, 5);
    }
    expect(brandTheme("#ffff00").foreground).toBe("#000000");
    expect(brandTheme("#1e3a8a").foreground).toBe("#ffffff");
    expect(brandTheme("not a colour").color).toBe("#111827");
    expect(brandTheme("#fef08a").contrastOnWhite).toBeLessThan(3);
  });

  it("explains branding errors in plain words", () => {
    expect(describeDbError({ code: "22023", message: "branding_invalid: that logo is not available" })).toBe("That logo is not available.");
  });
});

describe("logo uploads", () => {
  it("re-encodes PNG, JPEG and WebP to PNG, keeping transparency and aspect ratio within 1024 px", async () => {
    const wide = await processLogo(await transparentPng(2400, 300));
    expect(wide.ok && { w: wide.logo.width, h: wide.logo.height }).toEqual({ w: 1024, h: 128 });
    const tall = await processLogo(await transparentPng(200, 1600));
    expect(tall.ok && { w: tall.logo.width, h: tall.logo.height }).toEqual({ w: 128, h: 1024 });
    if (!wide.ok) throw new Error("wide logo refused");
    const meta = await sharp(wide.logo.png).metadata();
    expect(meta).toMatchObject({ format: "png", hasAlpha: true });
    const corner = await sharp(wide.logo.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0); // still transparent

    for (const bytes of [await opaqueJpeg(300, 120), await opaqueWebp(300, 120)]) {
      const result = await processLogo(bytes);
      expect(result.ok).toBe(true);
      if (result.ok) expect((await sharp(result.logo.png).metadata()).format).toBe("png");
    }
    const small = await processLogo(await transparentPng(200, 100));
    expect(small.ok && [small.logo.width, small.logo.height]).toEqual([200, 100]); // never enlarged
  });

  it("marks mostly light artwork for a dark backdrop", async () => {
    const white = await processLogo(await whiteOnTransparentPng(400, 100));
    const red = await processLogo(await transparentPng(400, 100));
    expect(white.ok && white.logo.needsDarkBackground).toBe(true);
    expect(red.ok && red.logo.needsDarkBackground).toBe(false);
  });

  it("refuses SVG, disguised, corrupt, animated, empty, tiny, oversized and huge files", async () => {
    const refused = async (bytes: Buffer) => {
      const result = await processLogo(bytes);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.message;
    };
    expect(await refused(svgLogo())).toMatch(/SVG isn't supported/);
    expect(await refused(htmlDisguisedAsPng())).toMatch(/isn't a PNG, JPEG or WebP/);
    expect(await refused(corruptPng())).toMatch(/isn't a PNG, JPEG or WebP/);
    expect(await refused(await animatedWebp())).toMatch(/Animated/);
    expect(await refused(await fullyTransparentPng(100, 100))).toMatch(/empty/);
    expect(await refused(await transparentPng(10, 10))).toMatch(/at least 16 pixels/);
    expect(await refused(Buffer.concat([await transparentPng(100, 100), Buffer.alloc(LOGO_MAX_UPLOAD_BYTES)]))).toMatch(/4 MB/);
    expect(await refused(await sharp({ create: { width: 9000, height: 20, channels: 3, background: "#123456" } }).png().toBuffer())).toMatch(/at most 8000/);
  });
});
