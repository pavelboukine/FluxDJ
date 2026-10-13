"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Expand, ImageOff, Play, RotateCw, X } from "lucide-react";
import type { OfferSnapshot } from "@/lib/pricing";
import { leadMediaIndex, mediaPath, mediaSrcSet, offerPackageMedia, packageMediaPath, packageMediaSrcSet, type ImageWidth, type MediaItem } from "@/lib/proposals/media";
import { cn } from "@/lib/utils";

/**
 * Gear photos and videos on the proposal, for clients and the staff preview.
 *
 *  - Photos come from the proposal's own media route (see lib/proposals/media),
 *    resized: `srcset` lets the browser pick the smallest size that is sharp
 *    for the box, and photos below the fold load lazily.
 *  - Gear photos keep their proportions inside a 4:3 frame on a white mat
 *    (letterboxed, never cropped), so equipment is never cut off and
 *    product shots on white or transparent backgrounds sit cleanly. Package
 *    photos show a whole setup, so they fill their frame (cropped from the
 *    centre); the viewer always shows the whole photo.
 *  - A gear card with several photos and videos can be browsed in place
 *    (arrows, arrow keys, swipe); the photo opens the full-screen viewer at
 *    the one shown, and the card shows the last one viewed there.
 *  - Speed: each photo is resized on request, so a size the viewer hasn't
 *    loaded yet costs one round trip. Pointing at (or focusing) a photo
 *    starts loading its full-screen size and the card's next and previous
 *    photos; the viewer shows the card's copy at once while the sharper one
 *    loads, then loads its neighbours. Loaded photos stay in the browser's
 *    private cache.
 *  - Videos never autoplay and are not requested until the viewer opens one
 *    in the gallery; the gallery has native controls.
 *  - A photo that fails is checked once (a HEAD request through the same
 *    access check). An ended session is reported to the page, other failures
 *    show an honest placeholder with a manual retry. Nothing retries on its own
 *    more than once.
 */

type MediaAt = { gearKey: string; index: number } | { packageKey: string };
type GalleryTarget = { gearKey: string; index: number; onIndex?: (index: number) => void } | { packageKey: string };

type MediaContextValue = {
  base: string;
  offer: OfferSnapshot;
  /** Opens a gear item's gallery at a position; `onIndex` receives the position shown when it closes. */
  openGallery: (gearKey: string, index: number, onIndex?: (index: number) => void) => void;
  openPackagePhoto: (packageKey: string) => void;
  onAccessLost?: () => void;
};

const MediaContext = createContext<MediaContextValue | null>(null);

function useMedia(): MediaContextValue {
  const value = useContext(MediaContext);
  if (!value) throw new Error("Gear media must be inside ProposalMediaProvider");
  return value;
}

export function ProposalMediaProvider({ base, offer, onAccessLost, children }: { base: string; offer: OfferSnapshot; onAccessLost?: () => void; children: ReactNode }) {
  const [target, setTarget] = useState<GalleryTarget | null>(null);
  const openGallery = useCallback((gearKey: string, index: number, onIndex?: (index: number) => void) => setTarget({ gearKey, index, onIndex }), []);
  const openPackagePhoto = useCallback((packageKey: string) => setTarget({ packageKey }), []);
  return (
    <MediaContext.Provider value={{ base, offer, openGallery, openPackagePhoto, onAccessLost }}>
      {children}
      {target ? <GalleryHost target={target} onClose={() => setTarget(null)} /> : null}
    </MediaContext.Provider>
  );
}

/** The viewer's photo size (also what pointing at a card photo warms up). */
const STAGE_SIZES = "(min-width: 1024px) 80vw, 100vw";

const pathFor = (base: string, at: MediaAt, width?: ImageWidth) => ("packageKey" in at ? packageMediaPath(base, at.packageKey, width) : mediaPath(base, at.gearKey, at.index, width));
const srcSetFor = (base: string, at: MediaAt) => ("packageKey" in at ? packageMediaSrcSet(base, at.packageKey) : mediaSrcSet(base, at.gearKey, at.index));
const atKey = (base: string, at: MediaAt) => ("packageKey" in at ? `${base} p ${at.packageKey}` : `${base} g ${at.gearKey}/${at.index}`);

/**
 * The largest copy of each photo this page has shown (its URL is in the
 * browser's cache), so the viewer can show it at once while a sharper one
 * loads. Page memory only; URLs are this proposal's own media routes.
 */
const shown = new Map<string, { src: string; width: number }>();
/** Photos already asked for ahead of time (by srcset and sizes), each once. */
const warmed = new Set<string>();
const warming = new Set<HTMLImageElement>();

/**
 * Loads a photo into the browser's cache ahead of time, at the size an
 * <img> with the same srcset and sizes would choose, at low priority. Only on
 * clear intent (a short hover, an arrow pointed at, a photo already shown),
 * since every photo warmed is resized on the server and counts against the
 * session's media budget.
 */
function warm(base: string, at: MediaAt, sizes: string) {
  if (typeof window === "undefined") return;
  const srcSet = srcSetFor(base, at);
  const key = `${sizes} ${srcSet}`;
  if (warmed.has(key)) return;
  warmed.add(key);
  const img = new Image();
  warming.add(img); // Held until it settles, so the request isn't dropped.
  img.onload = img.onerror = () => warming.delete(img);
  img.decoding = "async";
  img.fetchPriority = "low";
  img.sizes = sizes;
  img.srcset = srcSet;
}

/** Hover handlers that call `action` once a mouse has rested on the element briefly (not on touch, where the tap follows at once). */
function useHoverIntent(action: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  return {
    onPointerEnter: (e: { pointerType: string }) => {
      if (e.pointerType === "mouse") timer.current = setTimeout(action, 120);
    },
    onPointerLeave: () => clearTimeout(timer.current ?? undefined),
  };
}

type PhotoState = "loading" | "loaded" | "failed" | "ended" | "refused";

const frameClass = "@container/photo relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl";
// Over any photo, light or dark: a translucent dark disc with a light edge.
const overlayButton =
  "absolute top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-sm ring-1 ring-white/30 backdrop-blur-sm outline-none transition-opacity before:absolute before:-inset-2 hover:bg-black/75 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-white/90 @[14rem]/photo:size-9 pointer-fine:opacity-0 pointer-fine:group-hover/photo:opacity-100 pointer-fine:group-has-focus-visible/photo:opacity-100";
const badgeClass = "pointer-events-none absolute right-1 bottom-1 z-10 inline-flex items-center gap-1 rounded-full bg-black/65 p-1 text-xs font-medium text-white tabular-nums @[9rem]/photo:right-2 @[9rem]/photo:bottom-2 @[9rem]/photo:px-2";

/**
 * A gear item's photos and videos in a 4:3 frame. One item: a button that
 * opens the viewer. Several: also browsable in place (previous/next buttons,
 * arrow keys while focus is on the photo, a horizontal swipe), with the
 * position shown; the photo opens the viewer at that position. `sizes`
 * describes the rendered width for srcset selection.
 */
export function GearPhoto({ gearKey, sizes, className, label }: { gearKey: string; sizes: string; className?: string; label?: string }) {
  const { base, offer, openGallery } = useMedia();
  const gear = offer.gear[gearKey];
  const media = gear?.media ?? [];
  const count = media.length;
  const [index, setIndex] = useState(() => leadMediaIndex(media));
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const hover = useHoverIntent(() => {
    if (media[index]?.kind === "image") warm(base, { gearKey, index }, STAGE_SIZES);
  });

  if (!gear || index < 0 || !media[index]) {
    return (
      <div className={cn(frameClass, "flex-col gap-1 bg-muted text-muted-foreground", className)}>
        <ImageOff aria-hidden className="size-6" />
        <span className="text-xs">No photo yet</span>
      </div>
    );
  }
  const item = media[index];
  const name = label ?? gear.name;
  const kind = (m: MediaItem) => (m.kind === "video" ? "Video" : "Photo");
  const at = (i: number) => ({ gearKey, index: i });

  const step = (from: number, delta: number) => (from + delta + count) % count;
  // The card's size of the photo an arrow leads to (pointed at or focused: about to be pressed).
  const warmStep = (from: number, delta: number) => {
    const n = step(from, delta);
    if (media[n].kind === "image") warm(base, at(n), sizes);
  };
  const go = (delta: number) => {
    const next = step(index, delta);
    setIndex(next);
    warmStep(next, delta); // Likely the next press, in the same direction.
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (count < 2 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    go(e.key === "ArrowRight" ? 1 : -1);
  };

  return (
    <div data-testid="gear-photo" className={cn(frameClass, "group/photo bg-white ring-1 ring-black/5 ring-inset", className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        {...hover}
        onPointerDown={(e) => {
          swiped.current = false;
          swipe.current = count > 1 && e.pointerType !== "mouse" ? { x: e.clientX, y: e.clientY } : null;
        }}
        onPointerUp={(e) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = e.clientX - start.x;
          if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(e.clientY - start.y)) {
            swiped.current = true; // The click a browser may still send for this gesture is not an "open".
            go(dx < 0 ? 1 : -1);
          }
        }}
        onPointerCancel={() => (swipe.current = null)}
        onClick={() => {
          if (swiped.current) return void (swiped.current = false);
          openGallery(gearKey, index, setIndex);
        }}
        aria-label={count > 1 ? `View ${count} photos and videos of ${name}, from ${kind(item).toLowerCase()} ${index + 1}` : `View ${item.kind === "video" ? "video" : "photo"} of ${name}`}
        className={cn("absolute inset-0 flex cursor-zoom-in items-center justify-center rounded-[inherit] p-[3%] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset", count > 1 && "touch-pan-y touch-pinch-zoom")}
      >
        {item.kind === "image" ? <MediaImage key={index} at={at(index)} item={item} sizes={sizes} className="size-full object-contain" /> : <VideoPlaceholder />}
      </button>
      {count > 1 ? (
        <>
          <button type="button" onClick={() => go(-1)} onPointerEnter={() => warmStep(index, -1)} onFocus={() => warmStep(index, -1)} aria-label={`Previous photo of ${name}`} className={cn(overlayButton, "left-1 @[14rem]/photo:left-2")}>
            <ChevronLeft aria-hidden className="size-4 @[14rem]/photo:size-5" />
          </button>
          <button type="button" onClick={() => go(1)} onPointerEnter={() => warmStep(index, 1)} onFocus={() => warmStep(index, 1)} aria-label={`Next photo of ${name}`} className={cn(overlayButton, "right-1 @[14rem]/photo:right-2")}>
            <ChevronRight aria-hidden className="size-4 @[14rem]/photo:size-5" />
          </button>
          <span aria-hidden data-testid="photo-position" className={badgeClass}>
            <span className="px-1">
              {index + 1} / {count}
            </span>
          </span>
          <span className="sr-only" aria-live="polite">{`${kind(item)} ${index + 1} of ${count}`}</span>
        </>
      ) : (
        <span className={badgeClass}>
          <Expand aria-hidden className="size-3.5" />
          <span className="hidden @[9rem]/photo:inline">View</span>
        </span>
      )}
    </div>
  );
}

/**
 * A package's own photo (frozen with the offer), filling the same 4:3 frame
 * as gear photos: a setup reads best edge to edge, so it is cropped to the
 * frame from the centre (never stretched). It opens the viewer, which shows
 * the whole photo. The package card's equipment list opens the gear photos.
 */
export function PackagePhoto({ packageKey, sizes, className }: { packageKey: string; sizes: string; className?: string }) {
  const { base, offer, openPackagePhoto } = useMedia();
  const at = { packageKey };
  const hover = useHoverIntent(() => warm(base, at, STAGE_SIZES));
  const pkg = offer.packages.find((p) => p.key === packageKey);
  const item = offerPackageMedia(offer, packageKey);
  if (!pkg || !item) return null;
  // The photo keeps its own description; the button over it opens the viewer.
  return (
    <div data-testid="package-photo" className={cn(frameClass, "bg-muted", className)}>
      <MediaImage at={at} item={item} sizes={sizes} decorative={false} cover className="size-full object-cover" />
      <button
        type="button"
        onClick={() => openPackagePhoto(packageKey)}
        {...hover}
        aria-label={`View photo of ${pkg.name}`}
        className="absolute inset-0 cursor-zoom-in rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
      />
      <span className={badgeClass}>
        <Expand aria-hidden className="size-3.5" />
        <span className="hidden @[9rem]/photo:inline">View</span>
      </span>
    </div>
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
 * control) offers its own "Try again". With `placeholder`, a copy of the same
 * photo the page already showed stands in (same box) until this one loads.
 *
 * With `cover`, the photo fills its box: a photo of another shape is then
 * scaled to the box's height (wide) or width (tall), larger than `sizes`
 * says, and the route's widths are its longest side. Once its shape is known
 * (the first copy has loaded), `sizes` is corrected so the browser picks a
 * copy that is sharp at that scale.
 */
function MediaImage({
  at,
  item,
  sizes,
  className,
  eager,
  decorative = true,
  retryable = false,
  placeholder = false,
  cover = false,
  priority,
  onLoaded,
}: {
  at: MediaAt;
  item: MediaItem;
  sizes: string;
  className?: string;
  eager?: boolean;
  decorative?: boolean;
  retryable?: boolean;
  placeholder?: boolean;
  cover?: boolean;
  priority?: "high" | "low";
  onLoaded?: () => void;
}) {
  const { base, onAccessLost } = useMedia();
  const [state, setState] = useState<PhotoState>("loading");
  const [attempt, setAttempt] = useState(0);
  const probed = useRef(-1);
  const [standIn] = useState(() => (placeholder ? shown.get(atKey(base, at))?.src : undefined));
  const [coverSizes, setCoverSizes] = useState<string | null>(null);
  const srcSet = srcSetFor(base, at);
  const src = pathFor(base, at, 800) + (attempt ? `&retry=${attempt}` : "");

  function loaded(img: HTMLImageElement) {
    setState("loaded");
    if (cover && !coverSizes && img.naturalWidth > 0 && img.clientWidth > 0 && img.clientHeight > 0) {
      const aspect = img.naturalWidth / img.naturalHeight;
      // The longest side as drawn, in CSS pixels.
      const side = aspect > img.clientWidth / img.clientHeight ? img.clientHeight * Math.max(aspect, 1) : img.clientWidth * Math.max(1 / aspect, 1);
      if (Math.max(img.naturalWidth, img.naturalHeight) < side * window.devicePixelRatio * 0.95) setCoverSizes(`${Math.ceil(side)}px`);
    }
    const key = atKey(base, at);
    if (img.currentSrc && img.naturalWidth > (shown.get(key)?.width ?? 0)) shown.set(key, { src: img.currentSrc, width: img.naturalWidth });
    onLoaded?.();
  }

  async function onError() {
    if (probed.current === attempt) return; // One probe per attempt.
    probed.current = attempt;
    let status = 0;
    try {
      status = (await fetch(pathFor(base, at, 400), { method: "HEAD", cache: "no-store", credentials: "same-origin" })).status;
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
  const showStandIn = standIn && state === "loading";
  return (
    <>
      {showStandIn ? (
        // eslint-disable-next-line @next/next/no-img-element -- the page's own already-loaded copy of this photo
        <img src={standIn} alt="" aria-hidden data-testid="photo-stand-in" decoding="async" className={className} />
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- resized by the proposal's own media route */}
      <img
        key={attempt}
        ref={(img) => {
          // A server-rendered photo can finish (or fail) before React attaches
          // its handlers, so settle its state from the element on mount.
          if (img?.complete && state === "loading") {
            if (img.naturalWidth > 0) loaded(img);
            else if (img.currentSrc) void onError();
          }
        }}
        src={src}
        srcSet={srcSet.replaceAll(/w=(\d+)/g, attempt ? `w=$1&retry=${attempt}` : "w=$1")}
        sizes={coverSizes ?? sizes}
        alt={decorative ? "" : item.alt_text}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={priority}
        decoding="async"
        onLoad={(e) => loaded(e.currentTarget)}
        onError={() => void onError()}
        className={cn(className, state === "loading" && !showStandIn && "animate-pulse")}
      />
    </>
  );
}

type GalleryEntry = { at: MediaAt; item: MediaItem };

/** The viewer for whatever was opened: a gear item's photos and videos, or a package's photo. */
function GalleryHost({ target, onClose }: { target: GalleryTarget; onClose: () => void }) {
  const { offer } = useMedia();
  if ("packageKey" in target) {
    const pkg = offer.packages.find((p) => p.key === target.packageKey);
    const item = offerPackageMedia(offer, target.packageKey);
    if (!pkg || !item) return null;
    return <Gallery title={pkg.name} label={`${pkg.name}: photo`} description={pkg.description} entries={[{ at: { packageKey: pkg.key }, item }]} startIndex={0} onClose={onClose} />;
  }
  const gear = offer.gear[target.gearKey];
  const entries = (gear?.media ?? []).map((item, index) => ({ at: { gearKey: target.gearKey, index }, item }));
  if (!gear || entries.length === 0) return null;
  return (
    <Gallery
      title={gear.name}
      label={`${gear.name}: photos and videos`}
      description={gear.description}
      entries={entries}
      startIndex={target.index}
      onClose={(index) => {
        target.onIndex?.(index);
        onClose();
      }}
    />
  );
}

/**
 * Full-screen viewer, in the frozen order. A modal <dialog>: focus stays
 * inside, Escape closes, focus returns to the button that opened it. Arrow
 * keys and large buttons move between items; videos have native controls and
 * never autoplay. Photos are shown whole (never cropped).
 */
function Gallery({ title, label, description, entries, startIndex, onClose }: { title: string; label: string; description: string | null | undefined; entries: GalleryEntry[]; startIndex: number; onClose: (index: number) => void }) {
  const { base } = useMedia();
  const [index, setIndex] = useState(Math.min(Math.max(0, startIndex), entries.length - 1));
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => onClose(index);

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

  // Thumbnails wait for the first photo (or at most 1.5 s), so it isn't slowed by them.
  const [thumbnails, setThumbnails] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setThumbnails(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const count = entries.length;
  const go = useCallback((delta: number) => setIndex((i) => (count ? (i + delta + count) % count : 0)), [count]);
  // Once the photo shown has loaded: the thumbnails, and its neighbours, so moving on is quick.
  const onStageLoaded = useCallback(() => {
    setThumbnails(true);
    if (count < 2) return;
    for (const n of [(index + 1) % count, (index - 1 + count) % count]) if (entries[n].item.kind === "image") warm(base, entries[n].at, STAGE_SIZES);
  }, [base, count, entries, index]);
  const { at, item } = entries[index];
  const kind = (m: MediaItem) => (m.kind === "video" ? "Video" : "Photo");

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        close();
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
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-sm text-white/70" aria-live="polite">
              {count > 1 ? `${kind(item)} ${index + 1} of ${count}` : kind(item)}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={close} aria-label="Close" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 outline-none hover:bg-white/20 focus-visible:ring-3 focus-visible:ring-white/70">
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <div className="relative flex min-h-0 items-center justify-center px-2 sm:px-16">
          <GalleryStage key={atKey(base, at)} at={at} item={item} onLoaded={onStageLoaded} />
          {count > 1 ? (
            <>
              <button type="button" onClick={() => go(-1)} aria-label="Previous" className="absolute top-1/2 left-2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 outline-none hover:bg-black/80 focus-visible:ring-3 focus-visible:ring-white/70">
                <ChevronLeft aria-hidden className="size-6" />
              </button>
              <button type="button" onClick={() => go(1)} aria-label="Next" className="absolute top-1/2 right-2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 outline-none hover:bg-black/80 focus-visible:ring-3 focus-visible:ring-white/70">
                <ChevronRight aria-hidden className="size-6" />
              </button>
            </>
          ) : null}
        </div>

        <div className="grid gap-2 px-4 py-3">
          <p className="text-sm text-white/85">{item.alt_text}</p>
          {description ? <p className="max-w-prose text-xs text-white/60">{description}</p> : null}
          {count > 1 ? (
            <ul aria-label="All photos and videos" className="flex gap-2 overflow-x-auto pb-1">
              {entries.map((m, i) => (
                <li key={m.item.storage_path} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? "true" : undefined}
                    aria-label={`${kind(m.item)} ${i + 1}: ${m.item.alt_text}`}
                    className={cn("flex h-12 w-16 items-center justify-center overflow-hidden rounded-md border-2 bg-white/10 outline-none focus-visible:ring-3 focus-visible:ring-white/70", i === index ? "border-white" : "border-transparent")}
                  >
                    {m.item.kind === "video" ? <Play aria-hidden className="size-4" /> : thumbnails ? <MediaImage at={m.at} item={m.item} sizes="64px" priority="low" className="size-full object-contain" /> : null}
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

function GalleryStage({ at, item, onLoaded }: { at: MediaAt; item: MediaItem; onLoaded: () => void }) {
  const { base } = useMedia();
  const [videoFailed, setVideoFailed] = useState(0);
  if (item.kind === "image") {
    // The stand-in and the photo share one box, so the switch doesn't move anything.
    return (
      <div className="relative flex size-full items-center justify-center">
        <MediaImage at={at} item={item} sizes={STAGE_SIZES} eager decorative={false} retryable placeholder priority="high" onLoaded={onLoaded} className="absolute inset-0 size-full object-contain" />
      </div>
    );
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
      src={pathFor(base, at) + (videoFailed ? `?retry=${videoFailed}` : "")}
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
