"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DraftVersionProvider, useDraftEditorState } from "@/components/app/draft-version";

/**
 * Wraps a page-level form that tracks unsaved changes (ActionForm
 * trackUnsaved): leaving the page with typed values asks first. Put a
 * GuardedCancel inside (e.g. as the form's `secondary`) to cancel the same way.
 */
export function UnsavedGuard({ children }: { children: ReactNode }) {
  return (
    <DraftVersionProvider version={0}>
      {children}
      <LeaveWarning />
    </DraftVersionProvider>
  );
}

function LeaveWarning() {
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  return null;
}

/** Leaves for `cancelHref`, asking first when the guarded form has unsaved changes. */
export function GuardedCancel({ cancelHref, message }: { cancelHref: string; message: string }) {
  const router = useRouter();
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        if (unsaved && !window.confirm(message)) return;
        router.push(cancelHref);
      }}
    >
      Cancel
    </Button>
  );
}
