"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { legacySettingsHref } from "@/lib/navigation";

/** Sends an old /settings#anchor to the page that now holds it, replacing the history entry so Back doesn't return here. */
export function LegacySettingsHash({ slug }: { slug: string }) {
  const router = useRouter();
  useEffect(() => {
    const forward = () => {
      const href = legacySettingsHref(slug, window.location.hash, window.location.search);
      if (href) router.replace(href);
    };
    forward();
    window.addEventListener("hashchange", forward);
    return () => window.removeEventListener("hashchange", forward);
  }, [router, slug]);
  return null;
}
