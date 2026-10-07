"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Installable-app helpers. No service worker and no caching: the app is the
 * website opened from the home screen, always online. Nothing private is
 * kept in any browser storage; the only stored value is "install help
 * dismissed" (localStorage, a UI preference).
 */

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

// Chromium fires beforeinstallprompt once, possibly before any help is on
// screen; it is kept here (in memory only) until the help offers it.
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Mounted once in the root layout: captures the native install prompt for later. */
export function InstallPromptCapture() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // offered from the help card instead of interrupting
      deferred = e as InstallPromptEvent;
      notify();
    };
    const onInstalled = () => {
      deferred = null;
      notify();
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** True when running from the home screen (standalone display mode, or iOS's navigator.standalone). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function useStandalone(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia?.("(display-mode: standalone)");
      mq?.addEventListener("change", l);
      return () => mq?.removeEventListener("change", l);
    },
    isStandalone,
    () => false,
  );
}

type Platform = "ios-safari" | "ios-other" | "other";
function platform(): Platform {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return "other";
  return /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? "ios-safari" : "ios-other";
}

const DISMISSED = "flux:install-help-dismissed";
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

/**
 * A small, dismissible "Add to Home Screen" card for signed-in pages. Shown
 * only where installing is possible: the browser's own install prompt
 * (Chrome, Edge, Android), or Safari's Share menu on iPhone and iPad. Never
 * shown inside the installed app, and never again once dismissed. `compact`
 * is a quieter one-line strip for the staff shell.
 */
export function InstallHelp({ compact = false }: { compact?: boolean } = {}) {
  const prompt = useSyncExternalStore(subscribe, () => deferred, () => null);
  const standalone = useStandalone();
  const [ready, setReady] = useState<{ platform: Platform; dismissed: boolean } | null>(null);
  useEffect(() => {
    // Browser-only facts, read after hydration so the server and client render the same markup.
    const id = window.setTimeout(() => setReady({ platform: platform(), dismissed: readDismissed() }), 0);
    return () => window.clearTimeout(id);
  }, []);

  if (!ready || standalone || ready.dismissed) return null;
  const canPrompt = prompt !== null && ready.platform === "other";
  if (!canPrompt && ready.platform === "other") return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED, "1");
    } catch {
      // Private mode or blocked storage: hide for this visit only.
    }
    setReady({ ...ready, dismissed: true });
  };

  return (
    <aside
      aria-label="Add Flux DJ to your home screen"
      data-testid="install-help"
      className={cn(
        "flex flex-wrap justify-between",
        compact ? "items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-xs" : "items-start gap-3 rounded-xl border bg-muted/40 p-3 text-sm",
      )}
    >
      <div className={cn("min-w-0 flex-1", compact ? "flex flex-wrap items-baseline gap-x-1.5" : "grid gap-1")}>
        <p className="font-medium">Open Flux DJ from your home screen{compact ? "." : null}</p>
        {canPrompt ? (
          <p className="text-muted-foreground">Install it on this device for one-tap access. It still needs an internet connection.</p>
        ) : ready.platform === "ios-safari" ? (
          <p className="text-muted-foreground" data-testid="install-help-ios">
            In Safari, tap <span className="font-medium text-foreground">Share</span>, then{" "}
            <span className="font-medium text-foreground">Add to Home Screen</span>. It still needs an internet connection.
          </p>
        ) : (
          <p className="text-muted-foreground" data-testid="install-help-ios-other">
            Open this page in Safari, tap <span className="font-medium text-foreground">Share</span>, then{" "}
            <span className="font-medium text-foreground">Add to Home Screen</span>. It still needs an internet connection.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {canPrompt ? (
          <Button
            size={compact ? "xs" : "sm"}
            type="button"
            onClick={async () => {
              const event = deferred;
              if (!event) return;
              await event.prompt();
              await event.userChoice.catch(() => null);
              deferred = null; // a prompt can be used once
              notify();
            }}
          >
            Install
          </Button>
        ) : null}
        <Button size={compact ? "xs" : "sm"} variant="ghost" type="button" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </aside>
  );
}

/** An honest notice while the device is offline: pages and saves need a connection. */
export function OfflineNotice() {
  const online = useSyncExternalStore(
    (l) => {
      window.addEventListener("online", l);
      window.addEventListener("offline", l);
      return () => {
        window.removeEventListener("online", l);
        window.removeEventListener("offline", l);
      };
    },
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div
      role="status"
      data-testid="offline-notice"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-500/60 bg-amber-50 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-sm text-amber-950"
    >
      You&apos;re offline. Flux DJ needs a connection: what&apos;s on screen may be out of date, and changes can&apos;t be saved until you&apos;re back
      online.
    </div>
  );
}

/**
 * A PDF download that also works in the installed app. In a browser it is a
 * plain download link. From the home screen (where iOS would open the PDF
 * with no way back), the file is fetched with the app's own session and
 * handed to the share sheet (save to Files, print), or saved; it is held in
 * memory only, never stored.
 */
export function PdfDownloadLink({ href, children, className, fallbackName = "document.pdf" }: { href: string; children: ReactNode; className?: string; fallbackName?: string }) {
  const standalone = useStandalone();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function onClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!standalone) return; // the browser's normal download
    event.preventDefault();
    if (state === "busy") return;
    setState("busy");
    try {
      const response = await fetch(href, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/pdf")) throw new Error(String(response.status));
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
      const file = new File([await response.blob()], name, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch (e) {
          if ((e as Error).name !== "AbortError") throw e;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <span className="inline-grid justify-self-start gap-1">
      <a className={cn(className)} href={href} download onClick={onClick} aria-busy={state === "busy"}>
        {state === "busy" ? "Preparing PDF…" : children}
      </a>
      {standalone && state !== "error" ? (
        <span className="text-xs text-muted-foreground">Opens your phone&apos;s share options: save to Files or print.</span>
      ) : null}
      {state === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          Couldn&apos;t get the PDF. Check your connection and try again; if it keeps failing, open Flux DJ in your browser to download it.
        </span>
      ) : null}
    </span>
  );
}

