import type { CSSProperties } from "react";

/**
 * Brand colour helpers, shared by the browser (live preview) and the server.
 * The database validates the same #RRGGBB format (update_tenant_branding).
 */
export const DEFAULT_BRAND_COLOR = "#111827";
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LIGHT_TEXT = "#ffffff";
// Pure black: with white, it guarantees at least 4.58:1 on any colour (near-black does not).
const DARK_TEXT = "#000000";

/** "#1A2B3C" -> "#1a2b3c"; anything else -> null. */
export function normalizeHex(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export type BrandScheme = "light" | "dark";

/**
 * The surface brand accents sit on: white pages today, and the dark theme's
 * raised surface later (the lighter of its two backgrounds, so a colour that
 * reads there also reads on the page behind it). Nothing renders the dark
 * scheme yet; the derivations take it so dark mode needs no second model.
 */
const SURFACE: Record<BrandScheme, string> = { light: "#ffffff", dark: "#171717" };

/** The gradient preference inside brand_colors: present and "on", or absent. */
export const GRADIENT_ON = "on";

export type BrandGradient = { from: string; to: string };

export type BrandTheme = {
  scheme: BrandScheme;
  /** The brand colour (or the default). */
  color: string;
  /** Text on the brand colour: white or near-black, whichever reads better (always at least 4.5:1). */
  foreground: string;
  /** Contrast of that text on the brand colour. */
  foregroundContrast: number;
  /** Contrast of the brand colour against a white page (for borders and accents). */
  contrastOnWhite: number;
  /**
   * The brand colour as a legible accent on the page ("Brand Ink"): the same hue,
   * darkened (lightened on a dark page) until it reaches BRAND_INK_CONTRAST. Thin
   * indicators, the current section and small text use it, so a pale brand
   * (lavender, yellow) still reads. A brand that already reads is used as it is.
   */
  ink: string;
  /** A wash of the ink on the page ("Brand Tint"), for the current row and selected surfaces. */
  tint: string;
  /**
   * A fill for white text (primary buttons): the brand darkened until white reaches
   * BRAND_INK_CONTRAST on it. The same in both schemes; on a white page it is the ink.
   */
  fill: string;
  /** The accent colour, when the business chose gradient branding; otherwise null. */
  accent: string | null;
  /**
   * "Brand Gradient": from the primary's fill to the accent's, for one hero per page
   * with white text (at least BRAND_INK_CONTRAST at every point). Null for solid branding.
   */
  gradient: BrandGradient | null;
  /**
   * "Brand Wash": from the primary's tint to the accent's, behind ordinary text; both
   * inks keep 4.5:1 on every point of it. Null for solid branding.
   */
  wash: BrandGradient | null;
};

/** Brand Ink's minimum contrast on the page: text-safe (4.5:1) with margin for the off-white canvas and Brand Tint. */
export const BRAND_INK_CONTRAST = 5.2;
const BRAND_TINT_AMOUNT = 0.09;
/** Every gradient runs the same way, so a business's pages read as one family. */
const GRADIENT_ANGLE = "135deg";

type BrandInput = { primary: string; accent: string | null };

/**
 * A business's colours from either form callers hold: the primary colour alone
 * (solid branding, as before gradients existed) or the whole brand_colors object.
 * A gradient needs the explicit preference and a valid accent; an accent alone
 * (older data, or a remembered choice) changes nothing.
 */
function readBrand(brand: unknown): BrandInput {
  if (brand !== null && typeof brand === "object") {
    const colors = brand as Record<string, unknown>;
    const accent = colors.gradient === GRADIENT_ON ? normalizeHex(colors.accent) : null;
    return { primary: normalizeHex(colors.primary) ?? DEFAULT_BRAND_COLOR, accent };
  }
  return { primary: normalizeHex(brand) ?? DEFAULT_BRAND_COLOR, accent: null };
}

/** Whether these brand_colors ask for gradient branding (the preference and a usable accent). */
export function usesGradient(brand: unknown): boolean {
  return readBrand(brand).accent !== null;
}

export function brandTheme(brand: unknown, scheme: BrandScheme = "light"): BrandTheme {
  const { primary: color, accent } = readBrand(brand);
  const light = contrastRatio(color, LIGHT_TEXT);
  const dark = contrastRatio(color, DARK_TEXT);
  const ink = brandInk(color, scheme);
  const fill = brandInk(color, "light");
  const accentInk = accent ? brandInk(accent, scheme) : null;
  return {
    scheme,
    color,
    foreground: light >= dark ? LIGHT_TEXT : DARK_TEXT,
    foregroundContrast: Math.max(light, dark),
    contrastOnWhite: contrastRatio(color, LIGHT_TEXT),
    ink,
    tint: brandTint(ink, [ink], scheme),
    fill,
    accent,
    gradient: accent ? { from: fill, to: brandInk(accent, "light") } : null,
    wash: accentInk ? { from: brandTint(ink, [ink, accentInk], scheme), to: brandTint(accentInk, [ink, accentInk], scheme) } : null,
  };
}

/** The Brand Gradient as a CSS background: the gradient, or the solid fill for solid branding. */
export function brandGradientCss(theme: BrandTheme): string {
  return theme.gradient ? `linear-gradient(${GRADIENT_ANGLE}, ${theme.gradient.from}, ${theme.gradient.to})` : theme.fill;
}

/** The Brand Wash as a CSS background: the wash, or the solid Brand Tint for solid branding. */
export function brandWashCss(theme: BrandTheme): string {
  return theme.wash ? `linear-gradient(${GRADIENT_ANGLE}, ${theme.wash.from}, ${theme.wash.to})` : theme.tint;
}

/**
 * The page's hero (a proposal's header, a contract's band): the Brand Gradient
 * under white text for a business that chose one. For solid branding it is the
 * brand colour itself with its own readable text, exactly as before gradients.
 */
export function brandHero(theme: BrandTheme): { background: string; foreground: string } {
  return theme.gradient ? { background: brandGradientCss(theme), foreground: LIGHT_TEXT } : { background: theme.color, foreground: theme.foreground };
}

/**
 * What a business logo sits on, stated by the surface that shows it (never guessed from pixels):
 * - "light": a page, card or Brand Wash, or a hero in a light brand colour.
 * - "dark": a hero under white text (the Brand Gradient, or a solid hero in a dark brand colour),
 *   and dark mode later.
 */
export type LogoSurface = "light" | "dark";

/**
 * The surface of the page's hero (brandHero) for a logo, from the same contrast decision as its
 * text: dark whenever the hero carries white text (always for the Brand Gradient), light otherwise.
 */
export function heroLogoSurface(brand: unknown): LogoSurface {
  return brandHero(brandTheme(brand)).foreground === LIGHT_TEXT ? "dark" : "light";
}

/**
 * The hero surface of a proposal's frozen offer. Offers frozen with logo variants always carry
 * `logo_on_dark_storage_path` (null without one) and use heroLogoSurface. An offer sent before
 * has no such key and keeps the logo backdrops it was sent with: a solid hero as a light surface
 * (a light logo on its dark plate, any other logo as it is) and a gradient hero as a dark one
 * (any other logo on its white panel).
 */
export function frozenHeroLogoSurface(branding: { brand_colors: unknown; logo_on_dark_storage_path?: string | null }): LogoSurface {
  if (branding.logo_on_dark_storage_path !== undefined) return heroLogoSurface(branding.brand_colors);
  return usesGradient(branding.brand_colors) ? "dark" : "light";
}

/**
 * CSS variables for client-facing pages: --brand for branded buttons and --brand-foreground for text
 * on them; --brand-fill (the brand deepened for white text, --brand-fill-foreground) for buttons in
 * white text; --brand-ink for legible accents on the page and --brand-tint for selected surfaces.
 * --brand-gradient (white text) and --brand-wash (ordinary text) are backgrounds: gradients for a
 * business that chose them, the solid fill and tint otherwise, so a surface can use them without
 * asking which. --brand-hero and --brand-hero-foreground are the hero's background and text
 * (brandHero). Errors, warnings and disabled controls keep their own styles.
 *
 * Ink, Tint and Wash depend on the page they sit on, so they come for both themes (`-light`,
 * `-dark`), and globals.css picks one for the page's theme ([data-brand], set by brandProps): the
 * server render is right before the theme is known. The other variables read the same on both.
 *
 * The utilities bg-brand-wash, bg-brand-gradient and bg-brand-hero (globals.css) read these; pages
 * never write a gradient of their own.
 */
export function brandStyle(brand: unknown, extra: Record<string, string> = {}): CSSProperties {
  const theme = brandTheme(brand);
  const dark = brandTheme(brand, "dark");
  return {
    "--brand": theme.color,
    "--brand-foreground": theme.foreground,
    "--brand-fill": theme.fill,
    "--brand-fill-foreground": LIGHT_TEXT,
    "--brand-ink-light": theme.ink,
    "--brand-ink-dark": dark.ink,
    "--brand-tint-light": theme.tint,
    "--brand-tint-dark": dark.tint,
    "--brand-wash-light": brandWashCss(theme),
    "--brand-wash-dark": brandWashCss(dark),
    "--brand-gradient": brandGradientCss(theme),
    "--brand-hero": brandHero(theme).background,
    "--brand-hero-foreground": brandHero(theme).foreground,
    ...extra,
  } as CSSProperties;
}

/**
 * What a branded element carries: the variables above, `data-brand` (globals.css resolves Ink, Tint
 * and Wash for the theme there) and, only for a business that chose gradient branding,
 * data-brand-gradient. The `brand-gradient:` variant styles the few places a gradient adds something
 * a solid page doesn't have (a wash behind a header), so a business without the preference keeps its
 * exact layout as well as its colours.
 */
export function brandProps(brand: unknown, extra: Record<string, string> = {}): { style: CSSProperties; "data-brand": ""; "data-brand-gradient"?: "" } {
  const props = { style: brandStyle(brand, extra), "data-brand": "" as const };
  return usesGradient(brand) ? { ...props, "data-brand-gradient": "" } : props;
}

/**
 * The lowest contrast of a text colour anywhere along a two-colour gradient
 * (sampled as CSS blends it by default, in sRGB).
 */
export function gradientContrast(gradient: BrandGradient, text: string): number {
  const [from, to] = [hexToRgb(gradient.from), hexToRgb(gradient.to)];
  let lowest = Infinity;
  for (let step = 0; step <= 20; step += 1) {
    const at = rgbToHex(from.map((c, i) => c + ((to[i] - c) * step) / 20) as Rgb);
    lowest = Math.min(lowest, contrastRatio(at, text));
  }
  return lowest;
}

/** A suggested gradient: a name for the swatch and the accent colour that makes it. */
export type BrandLook = { key: string; label: string; accent: string };

const DEGREES = Math.PI / 180;
/** Looks nearer than this to each other, or to the primary's own fill, are the same look to the eye (OKLab distance). */
const LOOK_DISTANCE = 0.05;
const LOOKS_SHOWN = 4;

/** What a colour is called, by OKLCH hue (upper bound of each band, in degrees). */
const HUE_NAMES: [number, string][] = [[15, "Pink"], [40, "Red"], [75, "Amber"], [125, "Gold"], [165, "Green"], [228, "Teal"], [262, "Blue"], [285, "Indigo"], [315, "Violet"], [345, "Magenta"], [360, "Pink"]];

/** A candidate accent in OKLCH; a null label is named after its hue. */
type LookSpec = { key: string; label: string | null; L: number; C: number; hue: number };

/**
 * A few gradients that suit a primary colour, best first: the accents to offer
 * beside "Solid". Each is an ordinary accent colour (nothing else is stored),
 * already deep enough for white text, so a swatch shows exactly what is saved.
 *
 * They are measured from the shade the gradient really starts at (a pale brand
 * is deepened for white text), in OKLCH:
 *  - most colours: the two neighbouring hues, a deeper shade and a softer one;
 *  - dark colours: the same, lifted lighter, or the blend can't be seen;
 *  - greys and black: no hue to turn, so a little cool colour, or graphite;
 *  - yellows and limes: these turn olive when deepened, and olive's neighbours
 *    are more olive, so they pair with amber, ember, forest and charcoal instead.
 * Looks that come out alike, or like the solid colour, are dropped.
 */
export function suggestLooks(primary: unknown): BrandLook[] {
  const color = normalizeHex(primary) ?? DEFAULT_BRAND_COLOR;
  const fill = brandInk(color, "light");
  const [L, a, b] = toOklab(hexToRgb(fill));
  const C = Math.hypot(a, b);
  const hue = ((Math.atan2(b, a) / DEGREES) % 360 + 360) % 360;
  const dark = L < 0.34;

  let specs: LookSpec[];
  if (C < 0.03) {
    const l = L < 0.15 ? L + 0.34 : dark ? L + 0.24 : L;
    specs = [
      { key: "blue", label: null, L: l, C: 0.08, hue: 255 },
      { key: "violet", label: null, L: l, C: 0.08, hue: 300 },
      { key: "graphite", label: "Graphite", L: L < 0.15 ? L + 0.38 : dark ? L + 0.26 : L - 0.24, C: 0, hue: 0 },
      { key: "teal", label: null, L: l, C: 0.07, hue: 200 },
      { key: "plum", label: null, L: l, C: 0.08, hue: 345 },
    ];
  } else if (hue >= 60 && hue <= 125) {
    specs = [
      { key: "amber", label: "Amber", L: 0.5, C: 0.13, hue: 52 },
      { key: "charcoal", label: "Charcoal", L: 0.26, C: 0.012, hue },
      { key: "ember", label: "Ember", L: 0.44, C: 0.15, hue: 30 },
      { key: "forest", label: "Forest", L: 0.4, C: 0.09, hue: 152 },
      { key: "teal", label: null, L: 0.42, C: 0.08, hue: 195 },
    ];
  } else {
    // Enough chroma that a neighbouring hue is visibly a different colour, even for a muted brand.
    const c = Math.max(C, 0.11);
    const lift = dark ? 0.2 : 0;
    specs = [
      { key: "before", label: null, L: L + lift, C: c, hue: hue - 50 },
      { key: "after", label: null, L: L + lift, C: c, hue: hue + 50 },
      dark ? { key: "light", label: "Light", L: L + 0.26, C: c, hue } : { key: "deep", label: "Deep", L: L - 0.22, C: c * 0.85, hue },
      { key: "soft", label: "Soft", L: L + (dark ? 0.16 : 0.05), C: c * 0.55, hue: hue + 25 },
      // Spares, for when a look above is dropped.
      { key: "near", label: null, L: L + lift, C: c, hue: hue - 25 },
      { key: "far", label: null, L: L + lift, C: c, hue: hue + 80 },
      { key: "wide", label: null, L: L + lift, C: c, hue: hue - 80 },
      { key: "farther", label: null, L: L + lift, C: c, hue: hue + 110 },
      { key: "charcoal", label: "Charcoal", L: dark ? L + 0.3 : 0.26, C: 0.012, hue },
    ];
  }

  const start = toOklab(hexToRgb(fill));
  const kept: { look: BrandLook; lab: Rgb }[] = [];
  for (const spec of specs) {
    // A colour that lands on olive stops at the amber or green on the primary's own side of it.
    const turned = ((spec.hue % 360) + 360) % 360;
    const h = spec.C > 0.03 && turned > 62 && turned < 150 ? (hue < 105 || hue > 285 ? 55 : 158) : turned;
    const accent = brandInk(oklchToHex(Math.min(0.9, Math.max(0.12, spec.L)), spec.C, h * DEGREES), "light");
    const lab = toOklab(hexToRgb(accent));
    const apart = (other: Rgb) => Math.hypot(lab[0] - other[0], lab[1] - other[1], lab[2] - other[2]);
    if (apart(start) < LOOK_DISTANCE || kept.some((k) => apart(k.lab) < LOOK_DISTANCE)) continue;
    const label = spec.label ?? hueName(accent);
    // Two looks never share a name: the later one is described by what it does instead.
    kept.push({ look: { key: spec.key, label: kept.some((k) => k.look.label === label) ? `${label} 2` : label, accent }, lab });
    if (kept.length === LOOKS_SHOWN) break;
  }
  return kept.map((k) => k.look);
}

function hueName(hex: string): string {
  const [, a, b] = toOklab(hexToRgb(hex));
  if (Math.hypot(a, b) < 0.03) return "Graphite";
  const hue = ((Math.atan2(b, a) / DEGREES) % 360 + 360) % 360;
  return HUE_NAMES.find(([upTo]) => hue < upTo)![1];
}

// ---------------------------------------------------------------------------
// Brand Ink: darken in OKLCH (perceptual lightness), keeping the hue.
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB (0-1) to OKLab. */
function toOklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to linear sRGB (may fall outside 0-1 when out of gamut). */
function oklabToLinear([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** The OKLCH colour as hex, reducing chroma (never hue or lightness) until it fits sRGB. */
function oklchToHex(L: number, C: number, h: number): string {
  for (let c = C; c >= 0; c -= 0.002) {
    const lin = oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return rgbToHex(lin.map(toGamma) as Rgb);
  }
  return rgbToHex(oklabToLinear([L, 0, 0]).map(toGamma) as Rgb);
}

/**
 * The brand colour, moved in perceptual lightness until it reads on the scheme's
 * surface (see BrandTheme.ink): darker for a white page, lighter for a dark one.
 */
function brandInk(color: string, scheme: BrandScheme): string {
  const surface = SURFACE[scheme];
  if (contrastRatio(color, surface) >= BRAND_INK_CONTRAST) return color;
  const [L, a, b] = toOklab(hexToRgb(color));
  // A pale brand (low chroma) would darken to a grey; a little more chroma keeps it recognisably its hue.
  const C0 = Math.hypot(a, b);
  const C = C0 < 0.02 || C0 >= 0.1 ? C0 : Math.min(C0 * 1.8, 0.12);
  const h = Math.atan2(b, a);
  const step = scheme === "light" ? -0.005 : 0.005;
  for (let l = L; l > 0 && l < 1.001; l += step) {
    const hex = oklchToHex(l, C, h);
    if (contrastRatio(hex, surface) >= BRAND_INK_CONTRAST) return hex;
  }
  return scheme === "light" ? DEFAULT_BRAND_COLOR : LIGHT_TEXT;
}

/** A wash of a colour over the scheme's surface, as faint as needed for each of `inks` to keep 4.5:1 on it. */
function brandTint(color: string, inks: string[], scheme: BrandScheme): string {
  const reads = (tint: string) => inks.every((ink) => contrastRatio(ink, tint) >= 4.5);
  for (let amount = BRAND_TINT_AMOUNT; amount > 0.02; amount -= 0.01) {
    const tint = mix(color, SURFACE[scheme], amount);
    if (reads(tint)) return tint;
  }
  return mix(color, SURFACE[scheme], 0.02);
}

/** `amount` of the colour over a surface (mixed in sRGB, as CSS color-mix would by default). */
function mix(color: string, surface: string, amount: number): string {
  const base = hexToRgb(surface);
  return rgbToHex(hexToRgb(color).map((c, i) => amount * c + (1 - amount) * base[i]) as Rgb);
}
