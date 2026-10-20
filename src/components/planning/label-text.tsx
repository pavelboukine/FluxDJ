/**
 * A field or question label as people read it: optional fields carry a quiet "Optional" tag and
 * needed ones nothing extra (most planning questions are needed, so only the minority is marked).
 * The accessible name stays the full label ("Version (optional)", "Guest count (needed)"): the
 * words only move out of sight, so screen readers and tests read exactly what they did before.
 */
export function LabelText({ text }: { text: string }) {
  const m = /^(.*\S)\s*\((optional|needed|needed to complete)\)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <span>{m[1]}</span>
      <span className="sr-only"> ({m[2]})</span>
      {/* Drawn by CSS, so it's in neither the accessible name nor the label's text. */}
      {m[2] === "optional" ? <span aria-hidden className="text-xs font-normal text-plan-ink-2 after:content-['Optional']" /> : null}
    </>
  );
}
