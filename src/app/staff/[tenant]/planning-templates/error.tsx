"use client";

import { Button } from "@/components/ui/button";

/** Shown when a Planning templates page can't load (inside the staff shell); Try again re-renders it. */
export default function PlanningTemplatesError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="grid justify-items-start gap-3 rounded-xl border border-dashed px-4 py-8 text-sm" data-testid="planning-templates-error">
      <p className="font-medium">Planning templates couldn&apos;t be loaded.</p>
      <p className="text-muted-foreground">Nothing was changed. Check your connection and try again.</p>
      <Button type="button" variant="outline" size="sm" onClick={() => retry()}>Try again</Button>
    </div>
  );
}
