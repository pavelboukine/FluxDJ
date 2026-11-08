"use client";

import { ChevronLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "@/components/app/pending-link";
import { isActive, settingsNavigation } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Business Settings' navigation column, from lg. Smaller screens use the directory at /settings and a back link. */
export function SettingsNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="hidden lg:sticky lg:top-20 lg:grid lg:gap-5 lg:self-start">
      <Link
        href={`/staff/${slug}/settings`}
        data-testid="settings-all"
        className="-mb-1 inline-flex w-fit items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden className="-ml-1 size-4" />
        All settings
      </Link>
      {settingsNavigation(slug).map((group) => (
        <div key={group.label} className="grid gap-1">
          <h2 className="px-3 text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">{group.label}</h2>
          <ul className="grid gap-0.5">
            {group.pages.map((page) => {
              const active = isActive(page, pathname);
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-9 items-center rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                      active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <Link
        href={`/staff/${slug}/setup`}
        className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Setup guide
      </Link>
    </nav>
  );
}
