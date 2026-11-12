import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BRAND_INK_CONTRAST, brandGradientCss, brandHero, brandProps, brandStyle, brandTheme, brandWashCss, contrastRatio, gradientContrast, normalizeHex, suggestLooks, usesGradient } from "@/lib/branding/colors";
import { LOGO_MAX_UPLOAD_BYTES, processLogo } from "@/lib/branding/logo-upload.server";
import { describeDbError } from "@/lib/db-errors";
import {
  animatedWebp,
  corruptPng,
  fullyTransparentPng,
  htmlDisguisedAsPng,
  opaqueJpeg,
  opaqueWebp,
  svgLogo,
  paddedDiscPng, transparentPng,
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

  it("derives a Brand Ink that reads on white for any brand, keeping the hue, and a pale Brand Tint", () => {
    // Pale lavender (BOUPROD), a dark brand, a mid blue, pale yellow, white and pure hues.
    for (const color of ["#cbc7ff", "#111827", "#3b82f6", "#fef08a", "#ffffff", "#ffff00", "#e11d48", "#22c55e", "#0ea5e9"]) {
      const theme = brandTheme(color);
      expect(contrastRatio(theme.ink, "#ffffff"), color).toBeGreaterThanOrEqual(BRAND_INK_CONTRAST);
      expect(normalizeHex(theme.ink)).toBe(theme.ink);
      // The tint is a wash: barely darker than white, so ink text on it stays readable.
      expect(contrastRatio(theme.tint, "#ffffff")).toBeLessThan(1.25);
      expect(contrastRatio(theme.ink, theme.tint)).toBeGreaterThanOrEqual(4.5);
    }
    // A brand that already reads on white is its own ink.
    expect(brandTheme("#111827").ink).toBe("#111827");
    expect(brandTheme("#1e3a8a").ink).toBe("#1e3a8a");
    // A pale brand keeps its hue: lavender stays blue-violet (blue channel strongest), not grey.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(brandTheme("#cbc7ff").ink.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
    expect(b - g).toBeGreaterThan(40);
  });

  it("puts every brand token in the page's CSS variables", () => {
    expect(brandStyle("#cbc7ff")).toMatchObject({ "--brand": "#cbc7ff", "--brand-foreground": "#000000", "--brand-ink": brandTheme("#cbc7ff").ink, "--brand-tint": brandTheme("#cbc7ff").tint });
  });

  it("keeps solid branding exactly as it was for a business without the gradient preference", () => {
    // The values every existing business renders with today (BOUPROD's lavender and the default).
    expect(brandTheme("#cbc7ff")).toMatchObject({ color: "#cbc7ff", foreground: "#000000", ink: "#6d62b0", fill: "#6d62b0", accent: null, gradient: null, wash: null });
    expect(brandTheme(undefined)).toMatchObject({ color: "#111827", ink: "#111827", gradient: null, wash: null });
    // An accent alone (older data, the local seed, a remembered choice) is not a gradient, whichever way it is passed.
    const legacy = { primary: "#CBC7FF", accent: "#E11D48" };
    expect(usesGradient(legacy)).toBe(false);
    expect(brandTheme(legacy)).toEqual(brandTheme("#cbc7ff"));
    expect(brandStyle(legacy)).toEqual(brandStyle("#cbc7ff"));
    // The gradient variables still exist, as the solid fill and tint, so a surface can use them without asking.
    expect(brandStyle("#cbc7ff")).toMatchObject({ "--brand-gradient": "#6d62b0", "--brand-wash": brandTheme("#cbc7ff").tint });
    // Only the exact preference with a usable accent turns it on.
    for (const colors of [{ primary: "#1e3a8a", gradient: "on" }, { primary: "#1e3a8a", accent: "purple", gradient: "on" }, { primary: "#1e3a8a", accent: "#7c3aed", gradient: "off" }, { primary: "#1e3a8a", accent: "#7c3aed", gradient: true }, null, 42, []]) {
      expect(usesGradient(colors), JSON.stringify(colors)).toBe(false);
    }
    expect(usesGradient({ primary: "#1e3a8a", accent: "#7C3AED", gradient: "on" })).toBe(true);
  });

  // Primary and accent pairs: mid tones where neither white nor black text reads on the raw colours,
  // pale and dark brands, clashing lightness, greys and the extremes.
  const PAIRS: [string, string][] = [
    ["#dc2626", "#d07907"], ["#2563eb", "#9b60f6"], ["#0d9488", "#03758e"], ["#ec4899", "#da2a1f"],
    ["#cbc7ff", "#cda5d2"], ["#facc15", "#7c3aed"], ["#cbc7ff", "#111827"], ["#111827", "#fef08a"],
    ["#ffffff", "#000000"], ["#808080", "#ababab"], ["#ffff00", "#00ffff"], ["#111827", "#2e2839"],
  ];
  const gradientOf = (primary: string, accent: string) => ({ primary, accent, gradient: "on" });

  it("keeps white text readable at every point of a Brand Gradient, whatever two colours are chosen", () => {
    // The raw colours are the problem being solved: on red to amber neither text colour reaches 4.5:1.
    expect(gradientContrast({ from: "#dc2626", to: "#d07907" }, "#ffffff")).toBeLessThan(4.5);
    expect(gradientContrast({ from: "#dc2626", to: "#d07907" }, "#000000")).toBeLessThan(4.5);
    for (const [primary, accent] of PAIRS) {
      const theme = brandTheme(gradientOf(primary, accent));
      expect(theme.accent).toBe(accent);
      expect(gradientContrast(theme.gradient!, "#ffffff"), `${primary} to ${accent}`).toBeGreaterThanOrEqual(BRAND_INK_CONTRAST);
      // It starts from the same fill a solid primary button has, so buttons and heroes match.
      expect(theme.gradient!.from).toBe(brandTheme(primary).fill);
      expect(brandGradientCss(theme)).toBe(`linear-gradient(135deg, ${theme.gradient!.from}, ${theme.gradient!.to})`);
    }
    // Colours that already read under white text are used as chosen.
    expect(brandTheme(gradientOf("#1e3a8a", "#7c3aed")).gradient).toEqual({ from: "#1e3a8a", to: "#7c3aed" });
  });

  it("keeps ordinary text and both inks readable at every point of a Brand Wash", () => {
    // Planning's secondary text (--plan-ink-2) and the page's own text.
    const SECONDARY = "#585b63";
    for (const [primary, accent] of PAIRS) {
      const theme = brandTheme(gradientOf(primary, accent));
      const accentInk = brandTheme(accent).ink;
      for (const text of [theme.ink, accentInk, SECONDARY, "#0a0a0a"]) {
        expect(gradientContrast(theme.wash!, text), `${text} on ${primary} to ${accent}`).toBeGreaterThanOrEqual(4.5);
      }
      // Still a wash: barely darker than the page.
      for (const stop of [theme.wash!.from, theme.wash!.to]) expect(contrastRatio(stop, "#ffffff")).toBeLessThan(1.25);
      expect(brandWashCss(theme)).toBe(`linear-gradient(135deg, ${theme.wash!.from}, ${theme.wash!.to})`);
      expect(brandStyle(gradientOf(primary, accent))).toMatchObject({ "--brand": primary, "--brand-ink": theme.ink, "--brand-gradient": brandGradientCss(theme), "--brand-wash": brandWashCss(theme) });
    }
  });

  it("derives the same tokens for a dark page, ready for dark mode", () => {
    const DARK_SURFACE = "#171717";
    for (const [primary, accent] of PAIRS) {
      const theme = brandTheme(gradientOf(primary, accent), "dark");
      // Accents lighten until they read on the dark surface; the tint and wash stay close to it.
      expect(contrastRatio(theme.ink, DARK_SURFACE), primary).toBeGreaterThanOrEqual(BRAND_INK_CONTRAST);
      expect(contrastRatio(theme.ink, theme.tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.tint, DARK_SURFACE)).toBeLessThan(1.3);
      for (const text of [theme.ink, brandTheme(accent, "dark").ink, "#fafafa"]) expect(gradientContrast(theme.wash!, text), `${text} on ${primary} to ${accent}`).toBeGreaterThanOrEqual(4.5);
      // Fills carry white text in both themes, so buttons and gradients don't change with the theme.
      expect(theme.fill).toBe(brandTheme(primary).fill);
      expect(theme.gradient).toEqual(brandTheme(gradientOf(primary, accent)).gradient);
    }
    // A dark brand is lightened for a dark page and left alone on a light one.
    expect(brandTheme("#111827", "dark").ink).not.toBe("#111827");
    expect(brandTheme("#cbc7ff", "dark").ink).toBe("#cbc7ff");
    expect(brandTheme("#cbc7ff").scheme).toBe("light");
  });

  it("gives a page its hero and marks only gradient businesses, so solid pages keep colours and layout", () => {
    // Solid: the hero is the brand colour with its own readable text, as proposal headers always were.
    for (const brand of ["#cbc7ff", "#ffff00", "#111827", "#dc2626", { primary: "#cbc7ff", accent: "#E11D48" }, undefined, {}]) {
      const theme = brandTheme(brand);
      expect(brandHero(theme)).toEqual({ background: theme.color, foreground: theme.foreground });
      expect(contrastRatio(theme.color, theme.foreground)).toBeGreaterThanOrEqual(4.5);
      const props = brandProps(brand);
      expect(props).not.toHaveProperty("data-brand-gradient");
      expect(props.style).toMatchObject({ "--brand-hero": theme.color, "--brand-hero-foreground": theme.foreground, "--brand-gradient": theme.ink, "--brand-wash": theme.tint });
    }
    // Gradient: the hero is the Brand Gradient under white, and the page is marked for the brand-gradient variant.
    for (const [primary, accent] of PAIRS) {
      const brand = gradientOf(primary, accent);
      const theme = brandTheme(brand);
      expect(brandHero(theme)).toEqual({ background: brandGradientCss(theme), foreground: "#ffffff" });
      expect(brandProps(brand)).toMatchObject({ "data-brand-gradient": "", style: { "--brand-hero": brandGradientCss(theme), "--brand-hero-foreground": "#ffffff" } });
    }
    expect(brandProps("#cbc7ff", { "--plan-sticky-top": "1rem" }).style).toMatchObject({ "--brand": "#cbc7ff", "--plan-sticky-top": "1rem" });
  });

  // Easy and hard primaries: mid tones, pale, vivid light, warm, greys, white, black and dark brands.
  const PRIMARIES = ["#005e99", "#2563eb", "#dc2626", "#0d9488", "#cbc7ff", "#ec4899", "#facc15", "#ffff00", "#a3e635", "#f97316", "#808080", "#ffffff", "#000000", "#111827", "#1e3a8a", "#16a34a", "#7c3aed"];
  const oklab = (hex: string) => {
    const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const apart = (x: string, y: string) => Math.hypot(...oklab(x).map((v, i) => v - oklab(y)[i]));
  const hueOf = (hex: string) => ((Math.atan2(oklab(hex)[2], oklab(hex)[1]) * 180) / Math.PI + 360) % 360;
  const chromaOf = (hex: string) => Math.hypot(oklab(hex)[1], oklab(hex)[2]);

  it("suggests about four distinct, contrast-safe looks for any primary colour", () => {
    for (const primary of PRIMARIES) {
      const looks = suggestLooks(primary);
      expect(looks.length, primary).toBe(4);
      expect(suggestLooks(primary), primary).toEqual(looks); // the same looks every time
      expect(new Set(looks.map((l) => l.key)).size).toBe(looks.length);
      expect(new Set(looks.map((l) => l.label)).size).toBe(looks.length);
      const fill = brandTheme(primary).fill;
      for (const look of looks) {
        expect(normalizeHex(look.accent), `${primary} ${look.label}`).toBe(look.accent);
        const theme = brandTheme({ primary, accent: look.accent, gradient: "on" });
        // The swatch is honest: the saved accent is already deep enough, so the gradient ends on exactly it.
        expect(theme.gradient).toEqual({ from: fill, to: look.accent });
        expect(gradientContrast(theme.gradient!, "#ffffff"), `${primary} ${look.label}`).toBeGreaterThanOrEqual(BRAND_INK_CONTRAST);
        for (const text of [theme.ink, "#0a0a0a"]) expect(gradientContrast(theme.wash!, text)).toBeGreaterThanOrEqual(4.5);
        // Not the solid colour again, and not another look again.
        expect(apart(look.accent, fill), `${primary} ${look.label} against solid`).toBeGreaterThanOrEqual(0.05);
        for (const other of looks) if (other !== look) expect(apart(look.accent, other.accent), `${primary}: ${look.label} against ${other.label}`).toBeGreaterThanOrEqual(0.05);
      }
    }
    expect(suggestLooks("not a colour")).toEqual(suggestLooks("#111827"));
    // Made for the primary colour, not fixed palettes.
    expect(suggestLooks("#005e99").map((l) => l.accent)).not.toEqual(suggestLooks("#dc2626").map((l) => l.accent));
  });

  it("adapts the looks to difficult colours instead of offering more of the same", () => {
    // Yellow and lime deepen to olive; their looks lead away from it (amber, ember, forest, charcoal, teal), never to more olive.
    expect(suggestLooks("#facc15").map((l) => l.label)).toEqual(["Amber", "Charcoal", "Ember", "Forest"]);
    for (const primary of ["#facc15", "#ffff00", "#a3e635", "#dc2626", "#f97316", "#0d9488", "#16a34a"]) {
      for (const look of suggestLooks(primary)) {
        const olive = chromaOf(look.accent) > 0.04 && hueOf(look.accent) > 70 && hueOf(look.accent) < 128;
        expect(olive, `${primary} ${look.label} ${look.accent}`).toBe(false);
      }
    }
    // Greys and black have no hue to turn: they borrow a little colour, and keep a neutral look.
    for (const primary of ["#808080", "#ffffff", "#000000"]) {
      const looks = suggestLooks(primary);
      expect(looks.map((l) => l.label)).toContain("Graphite");
      expect(looks.filter((l) => chromaOf(l.accent) > 0.04).length).toBeGreaterThanOrEqual(2);
    }
    // Dark brands get lighter partners, or the blend can't be seen at all.
    for (const primary of ["#000000", "#111827"]) {
      for (const look of suggestLooks(primary)) expect(oklab(look.accent)[0], `${primary} ${look.label}`).toBeGreaterThan(oklab(primary)[0] + 0.1);
    }
    // Pale lavender's looks start from its deepened violet and stay in its family or beside it.
    expect(suggestLooks("#cbc7ff").map((l) => l.label)).toEqual(["Blue", "Magenta", "Deep", "Soft"]);
  });

  it("recognises a saved look by its accent alone, and anything else as the owner's own", () => {
    const looks = suggestLooks("#005e99");
    // What Settings does on load: nothing but the accent is stored.
    const saved = { primary: "#005e99", accent: looks[2].accent, gradient: "on" };
    expect(suggestLooks(saved.primary).find((l) => l.accent === saved.accent)?.key).toBe(looks[2].key);
    expect(suggestLooks("#005e99").find((l) => l.accent === "#ff2ee3")).toBeUndefined();
    // A custom accent still makes a safe gradient, deepened where it must be.
    const custom = brandTheme({ primary: "#005e99", accent: "#ff2ee3", gradient: "on" });
    expect(custom.accent).toBe("#ff2ee3");
    expect(gradientContrast(custom.gradient!, "#ffffff")).toBeGreaterThanOrEqual(BRAND_INK_CONTRAST);
  });

  it("explains branding errors in plain words", () => {
    expect(describeDbError({ code: "22023", message: "branding_invalid: choose an accent colour to use a gradient" })).toBe("Choose an accent colour to use a gradient.");
    expect(describeDbError({ code: "22023", message: "branding_invalid: that logo is not available" })).toBe("That logo is not available.");
  });
});

describe("logo uploads", () => {
  it("trims empty transparent edges so a margin can't shrink the visible logo, and crops nothing visible", async () => {
    const padded = await processLogo(await paddedDiscPng(1000, 250));
    if (!padded.ok) throw new Error("padded logo refused");
    expect(padded.logo.width).toBe(padded.logo.height);
    expect(padded.logo.width).toBeGreaterThanOrEqual(499);
    expect(padded.logo.width).toBeLessThanOrEqual(501);
    const { data, info } = await sharp(padded.logo.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    const edge = Math.floor(info.width / 2);
    // The disc still reaches all four edges, and they weren't cut past it.
    expect([alphaAt(edge, 0), alphaAt(edge, info.height - 1), alphaAt(0, edge), alphaAt(info.width - 1, edge)]).toEqual([255, 255, 255, 255]);
  });

  it("leaves a logo with no margin, and an opaque background, exactly as sized", async () => {
    const opaque = await processLogo(await opaqueJpeg(300, 120));
    expect(opaque.ok && [opaque.logo.width, opaque.logo.height]).toEqual([300, 120]);
    const flush = await processLogo(await paddedDiscPng(300, 0));
    expect(flush.ok && [flush.logo.width, flush.logo.height]).toEqual([300, 300]);
  });

  it("re-encodes PNG, JPEG and WebP to PNG, keeping transparency and aspect ratio within 1024 px", async () => {
    // The fixture draws inside 10-90% of the width and 20-80% of the height.
    const ratio = (l: { width: number; height: number }) => l.width / l.height;
    const wide = await processLogo(await transparentPng(2400, 300));
    if (!wide.ok) throw new Error("wide logo refused");
    expect(wide.logo.width).toBeLessThanOrEqual(1024);
    expect(ratio(wide.logo)).toBeCloseTo((2400 * 0.8) / (300 * 0.6), 0);
    const tall = await processLogo(await transparentPng(200, 1600));
    if (!tall.ok) throw new Error("tall logo refused");
    expect(tall.logo.height).toBeLessThanOrEqual(1024);
    expect(ratio(tall.logo)).toBeCloseTo((200 * 0.8) / (1600 * 0.6), 1);
    // A disc keeps transparent corners after trimming, so transparency itself is what's tested.
    const disc = await processLogo(await paddedDiscPng(400, 100));
    if (!disc.ok) throw new Error("disc refused");
    const meta = await sharp(disc.logo.png).metadata();
    expect(meta).toMatchObject({ format: "png", hasAlpha: true });
    const corner = await sharp(disc.logo.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0); // still transparent

    for (const bytes of [await opaqueJpeg(300, 120), await opaqueWebp(300, 120)]) {
      const result = await processLogo(bytes);
      expect(result.ok).toBe(true);
      if (result.ok) expect((await sharp(result.logo.png).metadata()).format).toBe("png");
    }
    const small = await processLogo(await opaqueWebp(200, 100));
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
