"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Expand, ImageOff, Images, Play, RotateCw, X } from "lucide-react";
import type { OfferSnapshot } from "@/lib/pricing";
import { leadMediaIndex, mediaPath, mediaSrcSet, type MediaItem } from "@/lib/proposals/media";
import { cn } from "@/lib/utils";

/**
 * Gear photos and videos on the proposal, for clients and the staff preview.
 *
 *  - Photos come from the proposal's own media route (see lib/proposals/media),
 *    resized: `srcset` lets the browser pick the smallest size that is sharp
 *    for the box, and photos below the fold load lazily.
 *  - Photos keep their proportions inside a 4:3 frame (letterboxed, never
 *    cropped), so equipment is never cut off.
 *  - Videos never autoplay and are not requested until the viewer opens one
 *    in the gallery; the gallery has native controls.
 *  - A photo that fails is checked once (a HEAD request through the same
 *    access check). An ended session is reported to the page, other failures
 *    show an honest placeholder with a manual retry. Nothing retries on its own
 *    more than once.
 */

type MediaContextValue = {
  base: string;
  offer: OfferSnapshot;
  openGallery: (gearKey: string, index: number) => void;
  onAccessLost?: () => void;
};

const MediaContext = createContext<MediaContextValue | null>(null);

function useMedia(): MediaContextValue {
  const value = useContext(MediaContext);
  if (!value) throw new Error("Gear media must be inside ProposalMediaProvider");
  return value;
}

export function ProposalMediaProvider({ base, offer, onAccessLost, children }: { base: string; offer: OfferSnapshot; onAccessLost?: () => void; children: ReactNode }) {
  const [target, setTarget] = useState<{ gearKey: string; index: number } | null>(null);
  const openGallery = useCallback((gearKey: string, index: number) => setTarget({ gearKey, index }), []);
  return (
    <MediaContext.Provider value={{ base, offer, openGallery, onAccessLost }}>
      {children}
      {target ? <GearGallery gearKey={target.gearKey} startIndex={target.index} onClose={() => setTarget(null)} /> : null}
    </MediaContext.Provider>
  );
}

type PhotoState = "loading" | "loaded" | "failed" | "ended" | "refused";

/**
 * The lead photo of a gear item in a 4:3 frame, as a button that opens the
 * gallery. `sizes` describes the rendered width for srcset selection.
 */
export function GearPhoto({ gearKey, sizes, className, label }: { gearKey: string; sizes: string; className?: string; label?: string }) {
  const { offer, openGallery } = useMedia();
  const gear = offer.gear[gearKey];
  const media = gear?.media ?? [];
  const index = leadMediaIndex(media);
  const item = index >= 0 ? media[index] : null;
  const count = media.length;

  const frame = cn("@container/photo relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-muted", className);
  if (!gear || !item) {
    return (
      <div className={cn(frame, "flex-col gap-1 text-muted-foreground")}>
        <ImageOff aria-hidden className="size-6" />
        <span className="text-xs">No photo yet</span>
      </div>
    );
  }
  const name = label ?? gear.name;
  return (
    <button
      type="button"
      onClick={() => openGallery(gearKey, index)}
      aria-label={count > 1 ? `View ${count} photos and videos of ${name}` : `View ${item.kind === "video" ? "video" : "photo"} of ${name}`}
      className={cn(frame, "group/photo cursor-zoom-in outline-none focus-visible:ring-3 focus-visible:ring-ring/60")}
    >
      {item.kind === "image" ? <MediaImage gearKey={gearKey} index={index} item={item} sizes={sizes} className="size-full object-contain" /> : <VideoPlaceholder />}
      <span className="pointer-events-none absolute right-1 bottom-1 inline-flex items-center gap-1 rounded-full bg-black/65 p-1 text-xs font-medium text-white @[9rem]/photo:right-2 @[9rem]/photo:bottom-2 @[9rem]/photo:px-2">
        {count > 1 ? <Images aria-hidden className="size-3.5" /> : <Expand aria-hidden className="size-3.5" />}
        <span className={count > 1 ? undefined : "hidden @[9rem]/photo:inline"}>{count > 1 ? count : "View"}</span>
      </span>
    </button>
  );
}

function VideoPlaceholder() {
  return (
    <span className="flex flex-col items-center gap-2 text-muted-foreground">
      <span className="flex size-12 items-center justify-center rounded-full bg-black/70 text-white">
        <Play aria-hidden className="size-5 translate-x-px" />
      </span>
      <span className="text-xs">Video · opens with controls</span>
    </span>
  );
}

/**
 * One resized photo with the failure handling described above. Decorative
 * inside labelled buttons; only the gallery's main photo (not inside another
 * control) offers its own "Try again".
 */
function MediaImage({ gearKey, index, item, sizes, className, eager, decorative = true, retryable = false }: { gearKey: string; index: number; item: MediaItem; sizes: string; className?: string; eager?: boolean; decorative?: boolean; retryable?: boolean }) {
  const { base, onAccessLost } = useMedia();
  const [state, setState] = useState<PhotoState>("loading");
  const [attempt, setAttempt] = useState(0);
  const probed = useRef(-1);
  const src = mediaPath(base, gearKey, index, 800) + (attempt ? `&retry=${attempt}` : "");

  async function onError() {
    if (probed.current === attempt) return; // One probe per attempt.
    probed.current = attempt;
    let status = 0;
    try {
      status = (await fetch(mediaPath(base, gearKey, index, 400), { method: "HEAD", cache: "no-store", credentials: "same-origin" })).status;
    } catch {
      status = 0;
    }
    if (status === 401) {
      setState("ended");
      onAccessLost?.();
    } else if (status === 403) setState("refused");
    else if (status === 200 && attempt === 0) setAttempt(1); // A transient failure: one automatic retry.
    else setState("failed");
  }

  if (state === "ended" || state === "refused" || state === "failed") {
    return (
      <span role="img" aria-label={`${item.alt_text} (photo unavailable)`} className="flex flex-col items-center gap-1 p-3 text-center text-xs text-muted-foreground">
        <ImageOff aria-hidden className="size-5" />
        {state === "ended" ? "Photo unavailable: your session has ended." : state === "refused" ? "Photo unavailable." : retryable ? "This photo couldn't load." : "This photo couldn't load. Open it to try again."}
        {state === "failed" && retryable ? (
          <button
            type="button"
            onClick={() => {
              setState("loading");
              setAttempt((a) => a + 1);
            }}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-3 underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
          >
            <RotateCw aria-hidden className="size-3" /> Try again
          </button>
        ) : null}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- resized by the proposal's own media route
    <img
      key={attempt}
      ref={(img) => {
        // A server-rendered photo can finish (or fail) before React attaches
        // its handlers, so settle its state from the element on mount.
        if (img?.complete && state === "loading") {
          if (img.naturalWidth > 0) setState("loaded");
          else if (img.currentSrc) void onError();
        }
      }}
      src={src}
      srcSet={mediaSrcSet(base, gearKey, index).replaceAll(/w=(\d+)/g, attempt ? `w=$1&retry=${attempt}` : "w=$1")}
      sizes={sizes}
      alt={decorative ? "" : item.alt_text}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onLoad={() => setState("loaded")}
      onError={() => void onError()}
      className={cn(className, state === "loading" && "animate-pulse")}
    />
  );
}

/**
 * Full-screen viewer for one gear item's photos and videos, in the frozen
 * order. A modal <dialog>: focus stays inside, Escape closes, focus returns
 * to the button that opened it. Arrow keys and large buttons move between
 * items; videos have native controls and never autoplay.
 */
function GearGallery({ gearKey, startIndex, onClose }: { gearKey: string; startIndex: number; onClose: () => void }) {
  const { offer } = useMedia();
  const gear = offer.gear[gearKey];
  const items = gear?.media ?? [];
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, items.length - 1)));
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    dialog?.showModal();
    closeRef.current?.focus();
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      if (dialog?.open) dialog.close();
      opener?.focus?.();
    };
  }, []);

  const count = items.length;
  const go = useCallback((delta: number) => setIndex((i) => (count ? (i + delta + count) % count : 0)), [count]);
  if (!gear || count === 0) return null;
  const item = items[index];

  return (
    <dialog
      ref={ref}
      aria-label={`${gear.name}: photos and videos`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        else if (e.key === "ArrowLeft") go(-1);
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-neutral-950 p-0 text-white backdrop:bg-black/80"
    >
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{gear.name}</h2>
            <p className="text-sm text-white/70" aria-live="polite">
              {count > 1 ? `${item.kind === "video" ? "Video" : "Photo"} ${index + 1} of ${count}` : item.kind === "video" ? "Video" : "Photo"}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 outline-none hover:bg-white/20 focus-visible:ring-3 focus-visible:ring-white/70">
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <div className="relative flex min-h-0 items-center justify-center px-2 sm:px-16">
          <GalleryStage key={`${gearKey}-${index}`} gearKey={gearKey} index={index} item={item} />
          {count > 1 ? (
            <>
              <button type="button" onClick={() => go(-1)} aria-label="Previous" className="absolute top-1/2 left-2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 outline-none hover:bg-black/80 focus-visible:ring-3 focus-visible:ring-white/70">
                <ChevronLeft aria-hidden className="size-6" />
              </button>
              <button type="button" onClick={() => go(1)} aria-label="Next" className="absolute top-1/2 right-2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 outline-none hover:bg-black/80 focus-visible:ring-3 focus-visible:ring-white/70">
                <ChevronRight aria-hidden className="size-6" />
              </button>
            </>
          ) : null}
        </div>

        <div className="grid gap-2 px-4 py-3">
          <p className="text-sm text-white/85">{item.alt_text}</p>
          {gear.description ? <p className="max-w-prose text-xs text-white/60">{gear.description}</p> : null}
          {count > 1 ? (
            <ul aria-label="All photos and videos" className="flex gap-2 overflow-x-auto pb-1">
              {items.map((m, i) => (
                <li key={m.storage_path} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? "true" : undefined}
                    aria-label={`${m.kind === "video" ? "Video" : "Photo"} ${i + 1}: ${m.alt_text}`}
                    className={cn("flex h-12 w-16 items-center justify-center overflow-hidden rounded-md border-2 bg-white/10 outline-none focus-visible:ring-3 focus-visible:ring-white/70", i === index ? "border-white" : "border-transparent")}
                  >
                    {m.kind === "image" ? <MediaImage gearKey={gearKey} index={i} item={m} sizes="64px" className="size-full object-contain" /> : <Play aria-hidden className="size-4" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function GalleryStage({ gearKey, index, item }: { gearKey: string; index: number; item: MediaItem }) {
  const { base } = useMedia();
  const [videoFailed, setVideoFailed] = useState(0);
  if (item.kind === "image") {
    return <MediaImage gearKey={gearKey} index={index} item={item} sizes="(min-width: 1024px) 80vw, 100vw" eager decorative={false} retryable className="max-h-full max-w-full object-contain" />;
  }
  if (videoFailed > 1) {
    return (
      <p role="img" aria-label={`${item.alt_text} (video unavailable)`} className="flex flex-col items-center gap-2 text-center text-sm text-white/80">
        <ImageOff aria-hidden className="size-6" />
        This video can&apos;t be played right now. If your session has ended, open the proposal again from your email.
      </p>
    );
  }
  return (
    // The route answers with a short-lived link to the original; a failed load
    // (for example a link that ran out mid-way) re-requests it once.
    <video
      key={videoFailed}
      src={mediaPath(base, gearKey, index) + (videoFailed ? `?retry=${videoFailed}` : "")}
      controls
      playsInline
      preload="none"
      aria-label={item.alt_text}
      onError={() => setVideoFailed((n) => n + 1)}
      className="max-h-full max-w-full bg-black"
    >
      {item.alt_text}
    </video>
  );
}

/** Opens the gallery for a gear item (for compact "photos" buttons next to text). */
export function useOpenGallery() {
  return useMedia().openGallery;
}
