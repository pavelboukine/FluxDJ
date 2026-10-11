import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** Shown only when a page was opened from the setup guide (`?from=setup`), so established businesses never see it. */
export function SetupReturn({ slug, from }: { slug: string; from: string | string[] | undefined }) {
  if (from !== "setup") return null;
  return (
    <Link
      href={`/staff/${slug}/setup`}
      data-testid="setup-return"
      className="inline-flex w-fit items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to setup guide
    </Link>
  );
}

