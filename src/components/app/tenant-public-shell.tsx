import type { ReactNode } from "react";
import { BrandLogo } from "@/components/app/brand-logo";
import { brandStyle } from "@/lib/branding/colors";
import { cn } from "@/lib/utils";

/**
 * A DJ business's own public page for one client step (a planning invitation today; other
 * client invitations can follow): the business's logo or name, its colour as the only accent,
 * the planning portal's neutral canvas and sheet, and "Powered by Flux DJ" at the foot. The
 * caller resolves the brand on the server (liveBrand: public branding by URL slug, for an
 * active business only) and falls back to PublicCard's neutral Flux frame when it can't.
 */
export type PublicBrand = {
  displayName: string;
  logo: { url: string; needsDarkBackground: boolean } | null;
  brandColors: Record<string, string>;
};

/** The primary action, filled with Brand Ink (white text stays readable on any brand colour, as in planning). */
export const BRAND_BUTTON = cn(
  "inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] px-5 text-sm font-semibold",
  "bg-brand-ink text-white hover:bg-[color-mix(in_oklab,var(--brand-ink),black_14%)] active:bg-[color-mix(in_oklab,var(--brand-ink),black_22%)]",
  "transition-colors motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-60",
  "outline-none focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2",
);

export function TenantPublicCard({ brand, title, description, children }: { brand: PublicBrand; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div data-plan-shell style={brandStyle(brand.brandColors.primary)} className="flex min-h-dvh flex-col bg-plan-canvas">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-6 pb-8 sm:justify-center sm:py-12">
        <section
          aria-labelledby="public-card-heading"
          className="grid gap-6 border-plan-hairline bg-plan-surface p-6 max-sm:-mx-4 max-sm:border-y sm:rounded-2xl sm:border sm:p-8"
        >
          {/* The business's name is on the door: its logo, contained whatever its shape, or its name. */}
          <div className="flex min-h-10 items-center">
            <BrandLogo
              logo={brand.logo}
              name={brand.displayName}
              className="max-h-14 max-w-48 sm:max-h-16 sm:max-w-56"
              fallbackClassName="text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]"
            />
          </div>
          <div className="grid gap-2">
            <h1 id="public-card-heading" className="text-2xl leading-tight font-semibold tracking-tight text-balance [overflow-wrap:anywhere]">{title}</h1>
            {description ? <p className="text-[0.9375rem] text-pretty text-plan-ink-2">{description}</p> : null}
          </div>
          <div className="grid gap-4 text-sm">{children}</div>
        </section>
      </main>
      <footer className="px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-plan-ink-2">Powered by Flux DJ</footer>
    </div>
  );
}
