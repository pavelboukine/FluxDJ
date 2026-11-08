"use client";

import { useEffect, type ReactNode } from "react";
import { hasUnsavedChanges } from "@/components/app/unsaved-navigation";

/** Marks the settings pages as guarded (see unsaved-navigation.ts) and asks before a tab with unsaved edits closes or reloads. */
export function SettingsUnsavedGuard({ children }: { children: ReactNode }) {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return <div data-unsaved-guard data-touch-fields className="grid min-w-0 content-start gap-8">{children}</div>;
}
