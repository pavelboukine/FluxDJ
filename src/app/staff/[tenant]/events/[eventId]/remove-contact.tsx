"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/forms";

export function RemoveContact({ action }: { action: () => Promise<ActionState> }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
        const result = await action();
        setMessage(result.status === "error" ? result.message : null);
      })}>
        Remove
      </Button>
      {message ? <span role="alert" className="text-xs text-destructive">{message}</span> : null}
    </span>
  );
}
