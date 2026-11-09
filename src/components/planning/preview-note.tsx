import type { CSSProperties, ReactNode } from "react";
import { Eye } from "lucide-react";
import { brandStyle } from "@/lib/branding/colors";

/**
 * Staff previews of the client's planning (a template on a sample event, or an event's plan as its
 * client sees it). The canvas carries the client page's look inside the staff shell; the note says,
 * at the top of the client's page, that this is a preview and nothing is saved.
 */

export function PreviewCanvas({ brandColor, readOnly = false, children }: {
  brandColor: string | undefined;
  /** The client's planning is closed: answers read as a review, as on the client's page (globals.css). */
  readOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-plan-shell
      data-plan-readonly={readOnly ? "" : undefined}
      data-testid="client-preview"
      // The business's colours, the planning field styles (data-plan-shell), and the planning bars kept
      // below the staff shell's own sticky bar.
      style={{ ...brandStyle(brandColor), "--plan-sticky-top": "calc(3.5rem + env(safe-area-inset-top))" } as CSSProperties}
      className="grid gap-5 rounded-2xl bg-plan-canvas px-4 pt-5 pb-8 max-sm:-mx-4 max-sm:rounded-none sm:gap-8 sm:px-6 sm:pt-6"
    >
      {children}
    </div>
  );
}

export function PreviewNote({ children }: { children: ReactNode }) {
  return (
    <p role="note" data-testid="preview-note" className="flex items-start gap-2 rounded-lg border border-sky-600/40 bg-sky-600/10 p-3 text-sm text-foreground">
      <Eye aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-semibold">Preview.</span> {children}
      </span>
    </p>
  );
}
