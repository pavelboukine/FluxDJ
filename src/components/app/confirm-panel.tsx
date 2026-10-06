"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A button that opens an inline confirmation dialog explaining an action's
 * effect, with the action's form inside. Cancel closes it without changes.
 */
export function ConfirmPanel({ label, title, children, variant = "outline" }: {
  label: string;
  title: string;
  children: ReactNode;
  variant?: "default" | "outline" | "secondary" | "destructive";
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div>
        <Button type="button" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
      </div>
    );
  }
  return (
    <div role="dialog" aria-label={title} className="grid gap-3 rounded-xl border-2 border-primary/40 p-4 text-sm">
      <p className="font-medium">{title}</p>
      {children}
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
