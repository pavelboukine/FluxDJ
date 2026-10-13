import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { FluxWordmark } from "@/components/app/app-shell";

/**
 * The public pages' frame (home, sign-in): the Flux wordmark linking home,
 * a calm full-height background, an optional slot beside the wordmark, and a
 * one-line footer. Signed-in areas keep their own shells. Single-task pages
 * (sign-in, confirm, invitations, opening a link) use PublicCard inside it.
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

/**
 * One focused step in the public frame (an invitation, a link being opened):
 * a card with an icon, a heading, an optional line under it, then the step's
 * content. Used by the staff, contract and proposal invitation pages, in the
 * sign-in pages' style.
 */
export function PublicCard({ icon: Icon, title, description, children }: { icon?: LucideIcon; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <PublicShell>
      <div className="flex flex-1 items-start justify-center pt-6 sm:items-center sm:pt-0">
        <section aria-labelledby="public-card-heading" className="grid w-full max-w-md gap-6 rounded-2xl border bg-card/95 p-6 shadow-sm backdrop-blur sm:p-8">
          <div className="grid gap-3">
            {Icon ? (
              <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Icon className="size-5" />
              </span>
            ) : null}
            <h1 id="public-card-heading" className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <div className="grid gap-4 text-sm">{children}</div>
        </section>
      </div>
    </PublicShell>
  );
}
