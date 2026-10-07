"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A business logo, or its name when there is no logo or it fails to load.
 * The image keeps its aspect ratio inside the given box (never stretched or
 * cropped). Mostly light logos sit on a dark backdrop so they stay visible on
 * light backgrounds; the alt text is the business name.
 */
export function BrandLogo({
  logo,
  name,
  className,
  fallbackClassName,
}: {
  logo: { url: string; needsDarkBackground: boolean } | null;
  name: string;
  /** Size of the image box, for example "h-8 max-w-40". */
  className?: string;
  fallbackClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!logo || failed) return <span className={fallbackClassName}>{name}</span>;
  return (
    <span className={cn("inline-flex items-center rounded-md", logo.needsDarkBackground ? "bg-neutral-900 px-1.5 py-1" : null)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a verified, re-encoded PNG */}
      <img src={logo.url} alt={name} className={cn("block w-auto object-contain", className)} onError={() => setFailed(true)} />
    </span>
  );
}
