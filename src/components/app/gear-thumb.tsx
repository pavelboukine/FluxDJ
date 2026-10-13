import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small square photo (a short-lived signed URL), or a no-photo placeholder.
 * Gear photos are products: shown whole on a white mat (`contain`), as
 * proposals show them. A package's own photo is a whole setup and fills the
 * square (`cover`).
 */
export function GearThumb({ url, className, fit = "contain" }: { url: string | null; className?: string; fit?: "contain" | "cover" }) {
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md", url && fit === "contain" ? "bg-white ring-1 ring-black/5 ring-inset" : "bg-muted", className)}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
        <img src={url} alt="" loading="lazy" decoding="async" className={fit === "contain" ? "size-full object-contain p-0.5" : "size-full object-cover"} />
      ) : (
        <ImageOff aria-hidden className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}
