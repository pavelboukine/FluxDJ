"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";

export function RuleToggle({ action, active }: { action: () => Promise<unknown>; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => void (await action()))}>
      {active ? "Archive" : "Restore"}
    </Button>
  );
}
