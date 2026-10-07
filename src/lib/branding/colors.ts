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
};

export function brandTheme(primary: unknown): BrandTheme {
  const color = normalizeHex(primary) ?? DEFAULT_BRAND_COLOR;
  const light = contrastRatio(color, LIGHT_TEXT);
  const dark = contrastRatio(color, DARK_TEXT);
  return {
    color,
    foreground: light >= dark ? LIGHT_TEXT : DARK_TEXT,
    foregroundContrast: Math.max(light, dark),
    contrastOnWhite: contrastRatio(color, LIGHT_TEXT),
  };
}

/**
 * CSS variables for client-facing pages: --brand for accents and branded
 * buttons, --brand-foreground for text on them. Errors, warnings and disabled
 * controls keep their own styles; nothing else is recoloured.
 */
export function brandStyle(primary: unknown, extra: Record<string, string> = {}): CSSProperties {
  const theme = brandTheme(primary);
  return { "--brand": theme.color, "--brand-foreground": theme.foreground, ...extra } as CSSProperties;
}
