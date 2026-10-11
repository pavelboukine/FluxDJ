import type { ReactNode } from "react";
import { FluxWordmark } from "@/components/app/app-shell";

/**
 * The public pages' frame (home, sign-in): the Flux wordmark linking home,
 * a calm full-height background, an optional slot beside the wordmark, and a
 * one-line footer. Signed-in areas keep their own shells.
 */
export function PublicShell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-x-clip bg-background">
      {/* A soft cool wash behind the top of the page; purely decorative. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[28rem] bg-gradient-to-b from-sky-100/70 via-sky-50/30 to-transparent dark:from-sky-950/40 dark:via-sky-950/10" />
      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <FluxWordmark href="/" className="h-6 sm:h-7" />
        {aside ? <div className="flex flex-wrap items-center justify-end gap-2">{aside}</div> : null}
      </header>
      <main className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-12 sm:px-6">{children}</main>
      <footer className="relative mx-auto w-full max-w-5xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
        Flux DJ · Proposals, contracts and event planning for DJs and their clients.
      </footer>
    </div>
  );
}
