import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FluxWordmark } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";

/**
 * The client pages' top bar: neutral Flux identity (a client can have events
 * with several businesses, so no single business brands it), a way back to
 * "Your events", and the account controls. No staff sidebar.
 */
export function ClientHeader({
  email,
  staffLink,
  signOut,
  back,
  title,
  wide,
}: {
  email: string | null;
  staffLink?: string | null;
  signOut?: () => Promise<void>;
  /** Shown on pages below the client home: back to "Your events", or to `back.href` (an event's hub, "Your event"). */
  back?: boolean | { href: string; label: string };
  /** The page's name in the bar (planning: "Your planning"), so a client knows which part of their event they're in. */
  title?: string;
  /** Matches a page wider than the usual reading column (planning). */
  wide?: boolean;
}) {
  return (
    <header className="border-b bg-background pt-[env(safe-area-inset-top)]">
      <div className={`mx-auto grid w-full ${wide ? "max-w-5xl" : "max-w-3xl"} grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-2`}>
        <div className="flex min-w-0 items-center gap-2">
          {back ? (
            <Link href={typeof back === "object" ? back.href : "/my"} className="inline-flex min-h-11 items-center gap-1.5 rounded-md pr-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <ArrowLeft aria-hidden className="size-4" />
              {typeof back === "object" ? back.label : "Your events"}
            </Link>
          ) : (
            <FluxWordmark href="/my" className="h-6" />
          )}
        </div>
        {title ? (
          <p className="truncate text-sm font-semibold" data-testid="client-page-title">
            {title}
          </p>
        ) : (
          <span />
        )}
        <nav aria-label="Account" className="flex min-w-0 items-center justify-end gap-2 text-sm">
          {email ? <span className="hidden max-w-56 truncate text-xs text-muted-foreground sm:inline">{email}</span> : null}
          {staffLink ? (
            <Link href={staffLink} className="inline-flex min-h-11 items-center rounded-md px-1 font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="sr-only">Go to your </span>Staff workspace
            </Link>
          ) : null}
          {signOut ? (
            <form action={signOut}>
              <Button variant="outline" type="submit" className="min-h-11 sm:min-h-9">
                Sign out
              </Button>
            </form>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
