import type { SectionStatus } from "@/lib/planning/navigation";
import { ProgressGlyph } from "@/components/app/status-glyph";

/** A planning section's status glyph (the shared ProgressGlyph), always shown next to its words. */
export function StatusGlyph({ status, className }: { status: SectionStatus; className?: string }) {
  return <ProgressGlyph state={status.state} className={className} />;
}

export { ProgressGlyph };
