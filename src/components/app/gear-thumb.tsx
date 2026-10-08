import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** A small square gear photo (a short-lived signed URL), or a no-photo placeholder. */
export function GearThumb({ url, className }: { url: string | null; className?: string }) {
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted", className)}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
        <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      ) : (
        <ImageOff aria-hidden className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}
