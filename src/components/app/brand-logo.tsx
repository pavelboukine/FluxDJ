"use client";

import { useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * A business logo, or its name when there is no logo or it fails to load.
 * The image keeps its aspect ratio inside the given box (never stretched or
 * cropped). Mostly light logos sit on a dark backdrop so they stay visible on
 * light backgrounds, and other logos on a white backdrop on a gradient hero
 * (`onHero`). The alt text is the business name. A surface that honours the
 * owner's logo size uses a height limit from lib/branding/logo-size.ts.
 */
export function BrandLogo({
  logo,
  name,
  className,
  fallbackClassName,
  onHero = false,
}: {
  logo: { url: string; needsDarkBackground: boolean; sizePercent?: number } | null;
  name: string;
  /** Size of the image box, for example "h-8 max-w-40". */
  className?: string;
  fallbackClassName?: string;
  /**
   * On the page's hero. A Brand Gradient is always dark (it carries white text), so there a logo
   * that isn't light gets a white backdrop, the same way a light logo gets its dark one. A solid
   * hero is unchanged.
   */
  onHero?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!logo || failed) return <span className={fallbackClassName}>{name}</span>;
  return (
    <span className={cn("inline-flex items-center rounded-md", logo.needsDarkBackground ? "bg-neutral-900 px-1.5 py-1" : onHero ? "brand-gradient:bg-white brand-gradient:px-1.5 brand-gradient:py-1" : null)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a verified, re-encoded PNG */}
      <img
        src={logo.url}
        alt={name}
        className={cn("block w-auto object-contain", className)}
        style={{ "--logo-scale": (logo.sizePercent ?? 100) / 100 } as CSSProperties}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
