/**
 * Light / Dark / System. The preference lives in this browser only (localStorage, THEME_STORAGE_KEY),
 * for staff, clients and anyone opening a proposal or contract link alike, and has nothing to do with
 * a business's branding. Only the marketing home page stays light for now (LIGHT_ONLY). Light paper
 * inside a dark page (a contract's text, the signature pad) opts out with the `light` class.
 */
export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemePreference = "system";
export const THEME_STORAGE_KEY = "flux-theme";

/** Pages that stay light whatever the preference: the marketing home page. */
const LIGHT_ONLY = new Set(["/"]);

/** Whether this path follows the viewer's theme preference (otherwise it is always light). */
export function followsTheme(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return !LIGHT_ONLY.has(pathname);
}

export const THEME_LABELS: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };
