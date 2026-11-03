import { ChevronRight } from "lucide-react";
import Link from "@/components/app/pending-link";
import { cn } from "@/lib/utils";

/**
 * A destination as one tappable row: the whole row is a single link (at
 * least 44px tall) with a title, optional supporting text and status, and a
 * trailing chevron. Text only, so nothing interactive can be nested in it;
 * its accessible name is that text, in reading order. Navigation goes
 * through PendingLink, so the shell's progress line shows while it's pending.
 * Same-page anchors ("#payments") work too: the browser follows them, and a
 * Disclosure that targets them opens. Keyboard focus scrolls it clear of the
 * shell's sticky header.
 */
export function LinkRow({
  href,
  title,
  detail,
  status,
  testId,
  className,
}: {
  href: string;
  title: string;
  /** Supporting text under the title ("Wedding agreement v3"). */
  detail?: string | null;
  /** A short state at the end of the row ("Signed Mar 2"). */
  status?: string | null;
  testId?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-slot="link-row"
      className={cn(
        "group/row flex min-h-11 scroll-mt-20 items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors select-none",
        "hover:bg-muted/50 active:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-medium [overflow-wrap:anywhere]">{title}</span>
        {detail ? <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</span> : null}
      </span>
      {status ? <span className="max-w-[45%] shrink-0 text-right text-muted-foreground">{status}</span> : null}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover/row:translate-x-0.5" />
    </Link>
  );
}
