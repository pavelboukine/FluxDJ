"use client";

import { Menu } from "@base-ui/react/menu";
import { Check, Monitor, Moon, Sun, SunMoon, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { THEME_LABELS, THEMES, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_ICONS: Record<ThemePreference, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

export const themeMenuItem =
  "flex min-h-11 w-full cursor-default items-center lg:min-h-9 gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none select-none data-highlighted:bg-muted data-disabled:text-muted-foreground";

/**
 * Light, Dark or System for this browser (next-themes keeps it in localStorage), as a radio group
 * inside a menu: the current choice is checked, and choosing one applies it at once and keeps the
 * menu open. Menus render only once opened, after the stored choice is known, so this never
 * renders a guess on the server. Shared by the staff account menu and the client header.
 */
export function ThemeRadioGroup({ itemClassName = themeMenuItem }: { itemClassName?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <Menu.RadioGroup value={theme ?? "system"} onValueChange={(value: ThemePreference) => setTheme(value)} data-testid="theme-choice">
      <Menu.GroupLabel className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">Theme</Menu.GroupLabel>
      {THEMES.map((value) => {
        const Icon = THEME_ICONS[value];
        return (
          <Menu.RadioItem key={value} value={value} closeOnClick={false} className={itemClassName}>
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{THEME_LABELS[value]}</span>
            <Menu.RadioItemIndicator keepMounted={false}>
              <Check aria-hidden className="size-4 shrink-0" />
            </Menu.RadioItemIndicator>
          </Menu.RadioItem>
        );
      })}
    </Menu.RadioGroup>
  );
}

/**
 * A compact Theme button with its own menu, for headers without an account menu (client pages).
 * The icon is the same whatever the theme, so the server render matches the browser's.
 */
export function ThemeMenu({ className }: { className?: string }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Theme"
        data-testid="theme-menu"
        className={cn(
          "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted sm:size-9",
          className,
        )}
      >
        <SunMoon aria-hidden className="size-5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" collisionPadding={8} className="z-50 outline-none">
          <Menu.Popup className="w-48 max-w-[calc(100vw-1rem)] origin-[var(--transform-origin)] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <ThemeRadioGroup />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
