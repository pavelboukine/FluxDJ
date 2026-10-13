"use client";

import { useState } from "react";
import { Film } from "lucide-react";
import { cn } from "@/lib/utils";

export type GalleryItem = { id: string; url: string | null; kind: string; alt: string };

/**
 * The item's active photos and videos as clients see them, in proposal order:
 * a large preview (whole, on the same white mat, videos never autoplay) and
 * thumbnail buttons to switch it.
 */
export function MediaGallery({ items }: { items: GalleryItem[] }) {
  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, items.length - 1)];
  if (!current) return null;
  return (
    <div className="grid gap-3" data-testid="gear-gallery">
      <div className={cn("flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg", current.url && current.kind === "image" ? "bg-white p-[3%] ring-1 ring-black/5 ring-inset" : "bg-muted")}>
        {current.url && current.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
          <img key={current.id} src={current.url} alt={current.alt} className="size-full object-contain" />
        ) : current.url ? (
          <video key={current.id} src={current.url} controls playsInline preload="metadata" aria-label={current.alt} className="max-h-full max-w-full" />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">This file can&apos;t be shown right now.</p>
        )}
      </div>
      {items.length > 1 ? (
        <ul aria-label="Photos and videos" className="flex flex-wrap gap-2">
          {items.map((m, i) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-pressed={m.id === current.id}
                aria-label={`Show ${m.kind === "video" ? "video" : "photo"} ${i + 1}: ${m.alt}`}
                className={cn(
                  "flex size-16 items-center justify-center overflow-hidden rounded-md border-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  m.url && m.kind === "image" ? "bg-white" : "bg-muted",
                  m.id === current.id ? "border-primary" : "border-transparent",
                )}
              >
                {m.url && m.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img src={m.url} alt="" loading="lazy" className="size-full object-contain p-0.5" />
                ) : (
                  <Film aria-hidden className="size-5 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
