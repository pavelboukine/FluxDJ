import { cn } from "@/lib/utils";

const WIDTHS = { narrow: "max-w-3xl", wide: "max-w-5xl", full: "max-w-none" } as const;

/**
 * A quiet "Powered by Flux" credit (the Flux wordmark) on a white bar, under
 * the page's own identity. Reusable on any page: place it last in a
 * `flex min-h-dvh flex-col` wrapper and it sits at the bottom of a short page
 * and after the content of a long one (never sticky or floating). `width`
 * matches the page's content column. Public invitation pages have their own
 * credit (TenantPublicShell).
 */
export function ClientFooter({ wide, width = wide ? "wide" : "narrow", className }: { wide?: boolean; width?: keyof typeof WIDTHS; className?: string }) {
  return (
    <footer data-testid="client-footer" className={cn("mt-auto border-t bg-background pb-[env(safe-area-inset-bottom)]", className)}>
      <div
        className={cn(
          "mx-auto flex w-full flex-col items-center gap-1.5 px-4 py-5 text-center text-xs text-plan-ink-2 sm:flex-row sm:justify-between sm:text-left",
          WIDTHS[width],
        )}
      >
        <p className="inline-flex items-center gap-1.5">
          Powered by
          {/* 452 x 160 trimmed artwork: height set here, width follows (never stretched). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- small static PNG; next/image adds nothing here */}
          <img src="/brand/flux-wordmark-black.png" alt="Flux DJ" width={452} height={160} className="block h-3.5 w-auto" data-testid="footer-flux-logo" />
        </p>
        <p>© {new Date().getFullYear()} Flux DJ. All rights reserved.</p>
      </div>
    </footer>
  );
}
