import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BrandLogo, type BrandLogoImage } from "@/components/app/brand-logo";
import { frozenHeroLogoSurface, GRADIENT_ON, heroLogoSurface, type LogoSurface } from "@/lib/branding/colors";
import { processLogo, whiteLogoVersion } from "@/lib/branding/logo-upload.server";
import { opaqueJpeg, transparentPng, twoColourPng, whiteOnTransparentPng } from "../support/logo-fixtures";

const MAIN = "https://example.test/main.png";
const ON_DARK = "https://example.test/on-dark.png";
const dark: BrandLogoImage = { url: MAIN, needsDarkBackground: false };
const light: BrandLogoImage = { url: MAIN, needsDarkBackground: true };
const withVariant = (logo: BrandLogoImage): BrandLogoImage => ({ ...logo, onDark: { url: ON_DARK } });

/** The image shown and the backdrop behind it. */
function shown(logo: BrandLogoImage | null, surface?: LogoSurface) {
  const html = renderToStaticMarkup(createElement(BrandLogo, { logo, name: "BOUPROD", className: "max-h-12", surface }));
  const src = html.match(/<img[^>]*src="([^"]+)"/)?.[1] ?? null;
  const wrapper = html.match(/<span class="([^"]*)"/)?.[1] ?? "";
  const backdrop = wrapper.includes("bg-white") ? "white" : wrapper.includes("bg-neutral-900") ? "dark" : "none";
  return { src, backdrop, html };
}

describe("which logo a surface shows", () => {
  it("names the hero's surface from the branding (the same decision as its text), never from the logo", () => {
    expect(heroLogoSurface({ primary: "#1e3a8a", accent: "#7c3aed", gradient: GRADIENT_ON })).toBe("dark");
    expect(heroLogoSurface({ primary: "#cbc7ff", accent: "#7c3aed", gradient: GRADIENT_ON })).toBe("dark"); // pale colours are deepened under white text
    expect(heroLogoSurface({ primary: "#111827" })).toBe("dark"); // solid and dark: white text, so a dark surface
    expect(heroLogoSurface("#111827")).toBe("dark");
    expect(heroLogoSurface(undefined)).toBe("dark"); // the default dark grey
    expect(heroLogoSurface({ primary: "#cbc7ff" })).toBe("light");
    expect(heroLogoSurface({ primary: "#ffff00", accent: "#7c3aed" })).toBe("light"); // an accent alone is not a gradient
  });

  it("light surfaces (pages, cards, the Brand Wash, a light hero) always show the main logo, as before", () => {
    expect(shown(withVariant(dark))).toMatchObject({ src: MAIN, backdrop: "none" });
    expect(shown(withVariant(light), "light")).toMatchObject({ src: MAIN, backdrop: "dark" });
  });

  it("dark surfaces show the logo for dark backgrounds directly, with no backdrop", () => {
    expect(shown(withVariant(dark), "dark")).toMatchObject({ src: ON_DARK, backdrop: "none" });
    expect(shown(withVariant(light), "dark")).toMatchObject({ src: ON_DARK, backdrop: "none" });
    expect(shown(withVariant(dark), "dark").html).toContain('data-logo="on-dark"');
  });

  it("keeps a single logo readable on any dark hero, solid or gradient: a light logo directly, any other on a compact white panel", () => {
    for (const brand of [{ primary: "#111827" }, { primary: "#1e3a8a", accent: "#7c3aed", gradient: GRADIENT_ON }]) {
      const surface = heroLogoSurface(brand);
      expect(shown(dark, surface)).toMatchObject({ src: MAIN, backdrop: "white" });
      expect(shown(light, surface)).toMatchObject({ src: MAIN, backdrop: "none" });
      expect(shown(dark, surface).html).toMatch(/class="[^"]*px-1\.5 py-1/); // compact: a small inset, not a band
    }
  });

  it("keeps a proposal sent before logo variants exactly as it was sent; newer offers use the surface rules", () => {
    const solidDark = { primary: "#111827" };
    const gradient = { primary: "#1e3a8a", accent: "#7c3aed", gradient: GRADIENT_ON };
    // Sent before: no key. A solid hero keeps no panel for a dark logo and the dark plate for a light one;
    // a gradient hero keeps the white panel it gave any other logo.
    expect(frozenHeroLogoSurface({ brand_colors: solidDark })).toBe("light");
    expect(shown(dark, frozenHeroLogoSurface({ brand_colors: solidDark }))).toMatchObject({ src: MAIN, backdrop: "none" });
    expect(shown(light, frozenHeroLogoSurface({ brand_colors: solidDark }))).toMatchObject({ src: MAIN, backdrop: "dark" });
    expect(shown(dark, frozenHeroLogoSurface({ brand_colors: gradient }))).toMatchObject({ src: MAIN, backdrop: "white" });
    expect(frozenHeroLogoSurface({ brand_colors: { primary: "#cbc7ff" } })).toBe("light");
    // Sent with variants: the key is present (null without a variant), and the hero's real surface applies.
    expect(frozenHeroLogoSurface({ brand_colors: solidDark, logo_on_dark_storage_path: null })).toBe("dark");
    expect(shown(dark, frozenHeroLogoSurface({ brand_colors: solidDark, logo_on_dark_storage_path: null }))).toMatchObject({ backdrop: "white" });
    expect(frozenHeroLogoSurface({ brand_colors: gradient, logo_on_dark_storage_path: "t/logos/x.png" })).toBe("dark");
    expect(frozenHeroLogoSurface({ brand_colors: { primary: "#cbc7ff" }, logo_on_dark_storage_path: null })).toBe("light");
  });

  it("never recolours a logo, except the Branding preview of a white version", () => {
    for (const surface of ["light", "dark"] as const) {
      expect(shown(withVariant(dark), surface).html).not.toMatch(/invert|brightness|filter/);
    }
    const preview = shown({ ...dark, onDark: { url: MAIN, white: true } }, "dark");
    expect(preview.src).toBe(MAIN);
    expect(preview.html).toMatch(/class="[^"]*brightness-0 invert/);
  });

  it("shows the business name without a logo", () => {
    expect(shown(null, "dark")).toMatchObject({ src: null });
    expect(shown(null, "dark").html).toContain("BOUPROD");
  });
});

/** A disc with smooth (anti-aliased) edges on transparency, drawn by sharp. */
const smoothDisc = (fill: string, size = 200) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 20}" fill="${fill}"/></svg>`)).png().toBuffer();

async function stored(bytes: Buffer) {
  const result = await processLogo(bytes);
  if (!result.ok) throw new Error(result.message);
  return result.logo.png;
}
const rgba = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

describe("white version of a single-colour logo", () => {
  it("turns every pixel white and keeps the shape, its smooth edges and the size", async () => {
    const original = await stored(await smoothDisc("#111111"));
    const white = await whiteLogoVersion(original);
    expect(white).not.toBeNull();
    const [before, after] = [await rgba(original), await rgba(white!.png)];
    expect([after.info.width, after.info.height]).toEqual([before.info.width, before.info.height]);
    let partial = 0;
    for (let i = 0; i < after.data.length; i += 4) {
      expect(after.data[i + 3]).toBe(before.data[i + 3]); // transparency, pixel for pixel
      if (after.data[i + 3] > 0) expect([after.data[i], after.data[i + 1], after.data[i + 2]]).toEqual([255, 255, 255]);
      if (before.data[i + 3] > 0 && before.data[i + 3] < 255) partial++;
    }
    expect(partial).toBeGreaterThan(0); // the fixture really has anti-aliased edges
    expect(white!.needsDarkBackground).toBe(true);
    expect(white!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A save stores it like any upload: the pipeline accepts it unchanged.
    const reprocessed = await processLogo(white!.png);
    expect(reprocessed.ok && [reprocessed.logo.width, reprocessed.logo.height]).toEqual([white!.width, white!.height]);
  });

  it("works for any single ink, not only black", async () => {
    expect(await whiteLogoVersion(await stored(await smoothDisc("#e11d48")))).not.toBeNull();
    // A filled rectangle has no transparent background once its empty edges are trimmed: nothing to keep.
    expect(await whiteLogoVersion(await stored(await transparentPng(400, 100)))).toBeNull();
  });

  it("refuses artwork it can't turn white without losing something", async () => {
    expect(await whiteLogoVersion(await stored(await twoColourPng()))).toBeNull(); // several colours
    expect(await whiteLogoVersion(await stored(await opaqueJpeg(300, 300)))).toBeNull(); // no transparent background
    expect(await whiteLogoVersion(await stored(await whiteOnTransparentPng(400, 100)))).toBeNull(); // already light
    expect(await whiteLogoVersion(Buffer.from("not an image"))).toBeNull();
  });

  it("never changes the original", async () => {
    const original = await stored(await smoothDisc("#1e3a8a"));
    const copy = Buffer.from(original);
    await whiteLogoVersion(original);
    expect(original.equals(copy)).toBe(true);
  });
});
