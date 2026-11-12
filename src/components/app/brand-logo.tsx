"use client";

import { useState, type CSSProperties } from "react";
import type { LogoSurface } from "@/lib/branding/colors";
import { cn } from "@/lib/utils";

export type BrandLogoImage = {
  url: string;
  needsDarkBackground: boolean;
  sizePercent?: number;
  /**
   * The business's own version of the logo for dark backgrounds, if it has one. `white` is for the
   * Branding preview only: the main logo drawn white, exactly as the white version a save creates.
   */
  onDark?: { url: string; white?: boolean };
};

/**
 * A business logo, or its name when there is no logo or it fails to load.
 * The image keeps its aspect ratio inside the given box (never stretched or
 * cropped). The alt text is the business name. A surface that honours the
 * owner's logo size uses a height limit from lib/branding/logo-size.ts.
 *
 * Which image, and whether it needs a backdrop, follows the surface it sits on
 * (`surface`, stated by the caller; heroLogoSurface for a page's hero):
 * - light (default): the logo; a mostly light logo gets a dark backdrop.
 * - dark (a hero under white text, solid or gradient; dark mode later): the
 *   logo for dark backgrounds when the business has one, with no backdrop.
 *   Otherwise a light logo as it is, and any other logo on a compact white
 *   backdrop, so a single logo always stays readable. "Light" is the upload's
 *   own classification (needsDarkBackground); no image is analysed here.
 * Logos are never recoloured.
 */
export function BrandLogo({
  logo,
  name,
  className,
  fallbackClassName,
  surface = "light",
}: {
  logo: BrandLogoImage | null;
  name: string;
  /** Size of the image box, for example "h-8 max-w-40". */
  className?: string;
  fallbackClassName?: string;
  surface?: LogoSurface;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const variant = logo && surface !== "light" ? logo.onDark : undefined;
  const src = variant?.url ?? logo?.url;
  if (!logo || !src || failed === src) return <span className={fallbackClassName}>{name}</span>;
  // A compact backdrop only for a single logo that wouldn't read on this surface.
  const backdrop = variant ? null : surface === "dark" ? (logo.needsDarkBackground ? null : "bg-white px-1.5 py-1") : logo.needsDarkBackground ? "bg-neutral-900 px-1.5 py-1" : null;
  return (
    <span className={cn("inline-flex items-center rounded-md", backdrop)} data-logo={variant ? "on-dark" : "main"}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a verified, re-encoded PNG */}
      <img
        src={src}
        alt={name}
        className={cn("block w-auto object-contain", variant?.white && "brightness-0 invert", className)}
        style={{ "--logo-scale": (logo.sizePercent ?? 100) / 100 } as CSSProperties}
        onError={() => setFailed(src)}
      />
    </span>
  );
}
