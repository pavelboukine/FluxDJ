"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { DEFAULT_THEME, followsTheme, THEME_STORAGE_KEY, THEMES } from "@/lib/theme";

/**
 * The viewer's Light / Dark / System preference (next-themes): `dark` on <html> in dark mode, set by
 * next-themes' inline script before the first paint, so there is no flash of the wrong theme, and kept
 * in step with the system setting while "System" is chosen. Outside the staff and platform areas the
 * theme is forced to light (followsTheme): the path is known while rendering on the server and in the
 * browser alike, so both render the same and the inline script applies light on those pages too.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ThemeProvider
      attribute="class"
      themes={THEMES.filter((t) => t !== "system")}
      defaultTheme={DEFAULT_THEME}
      enableSystem
      enableColorScheme
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      forcedTheme={followsTheme(pathname) ? undefined : "light"}
      // The inline script must run only from the server's HTML, before the first paint. When React renders
      // the provider in the browser instead (an offline page, a recovered error), a script there would never
      // run and React 19 reports it, so it is a data block (type="application/json"); next-themes' own effects
      // apply the theme then. The tag carries suppressHydrationWarning, so the differing type is expected.
      scriptProps={{ type: typeof window === "undefined" ? "text/javascript" : "application/json" }}
    >
      {children}
    </ThemeProvider>
  );
}
