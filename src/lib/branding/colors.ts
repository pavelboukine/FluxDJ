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

export type BrandTheme = {
  /** The brand colour (or the default). */
  color: string;
  /** Text on the brand colour: white or near-black, whichever reads better (always at least 4.5:1). */
  foreground: string;
  /** Contrast of that text on the brand colour. */
  foregroundContrast: number;
  /** Contrast of the brand colour against a white page (for borders and accents). */
  contrastOnWhite: number;
  /**
   * The brand colour as a legible accent on white ("Brand Ink"): the same hue,
   * darkened until it reaches BRAND_INK_CONTRAST. Thin indicators, the current
   * section and small text use it, so a pale brand (lavender, yellow) still reads.
   * A brand that already reads on white is used as it is.
   */
  ink: string;
  /** A wash of the ink on white ("Brand Tint"), for the current row and selected surfaces. */
  tint: string;
};

/** Brand Ink's minimum contrast on white: text-safe (4.5:1) with margin for the off-white canvas and Brand Tint. */
export const BRAND_INK_CONTRAST = 5.2;
const BRAND_TINT_AMOUNT = 0.09;

export function brandTheme(primary: unknown): BrandTheme {
  const color = normalizeHex(primary) ?? DEFAULT_BRAND_COLOR;
  const light = contrastRatio(color, LIGHT_TEXT);
  const dark = contrastRatio(color, DARK_TEXT);
  const ink = brandInk(color);
  return {
    color,
    foreground: light >= dark ? LIGHT_TEXT : DARK_TEXT,
    foregroundContrast: Math.max(light, dark),
    contrastOnWhite: contrastRatio(color, LIGHT_TEXT),
    ink,
    tint: brandTint(ink),
  };
}

/**
 * CSS variables for client-facing pages: --brand for branded buttons,
 * --brand-foreground for text on them, --brand-ink for legible accents on
 * white and --brand-tint for selected surfaces. Errors, warnings and disabled
 * controls keep their own styles; nothing else is recoloured.
 */
export function brandStyle(primary: unknown, extra: Record<string, string> = {}): CSSProperties {
  const theme = brandTheme(primary);
  return {
    "--brand": theme.color,
    "--brand-foreground": theme.foreground,
    "--brand-ink": theme.ink,
    "--brand-tint": theme.tint,
    ...extra,
  } as CSSProperties;
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

/** The brand colour, darkened in perceptual lightness until it reads on white (see BrandTheme.ink). */
function brandInk(color: string): string {
  if (contrastRatio(color, LIGHT_TEXT) >= BRAND_INK_CONTRAST) return color;
  const [L, a, b] = toOklab(hexToRgb(color));
  // A pale brand (low chroma) would darken to a grey; a little more chroma keeps it recognisably its hue.
  const C0 = Math.hypot(a, b);
  const C = C0 < 0.02 || C0 >= 0.1 ? C0 : Math.min(C0 * 1.8, 0.12);
  const h = Math.atan2(b, a);
  for (let l = L; l > 0; l -= 0.005) {
    const hex = oklchToHex(l, C, h);
    if (contrastRatio(hex, LIGHT_TEXT) >= BRAND_INK_CONTRAST) return hex;
  }
  return DEFAULT_BRAND_COLOR;
}

/** A wash of the ink, as light as needed for ink text on it to keep 4.5:1. */
function brandTint(ink: string): string {
  for (let amount = BRAND_TINT_AMOUNT; amount > 0.02; amount -= 0.01) {
    const tint = mixWithWhite(ink, amount);
    if (contrastRatio(ink, tint) >= 4.5) return tint;
  }
  return mixWithWhite(ink, 0.02);
}

/** `amount` of the colour over white (mixed in sRGB, as CSS color-mix would by default). */
function mixWithWhite(color: string, amount: number): string {
  return rgbToHex(hexToRgb(color).map((c) => amount * c + (1 - amount)) as Rgb);
}
