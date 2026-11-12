import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, followsTheme, THEME_LABELS, THEMES } from "@/lib/theme";

describe("theme preference", () => {
  it("offers Light, Dark and System, and starts on System", () => {
    expect(THEMES).toEqual(["light", "dark", "system"]);
    expect(THEMES.map((t) => THEME_LABELS[t])).toEqual(["Light", "Dark", "System"]);
    expect(DEFAULT_THEME).toBe("system");
  });

  it("applies everywhere but the marketing home page, which stays light", () => {
    for (const path of ["/staff", "/staff/bouprod/settings/branding", "/platform/operations", "/login", "/auth/confirm", "/my", "/my/continue", "/start", "/join/abc", "/bouprod/p", "/bouprod/events/e1", "/bouprod/proposals/p1", "/bouprod/contracts/c1", "/bouprod/planning/e1", "/unavailable"]) {
      expect(followsTheme(path), path).toBe(true);
    }
    for (const path of ["/", null, undefined, ""]) {
      expect(followsTheme(path), String(path)).toBe(false);
    }
  });
});
