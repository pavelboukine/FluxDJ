import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatImportedAnswer, type Imported, type PlanStage, type PlanStructure } from "@/lib/planning/view";
import { isStageEditor } from "@/lib/planning/stages";
import { ItemStatus } from "./progress";

/**
 * Read-only pieces of a plan shared by the client and staff pages. Sections
 * without an editor say "Not available yet" and offer no inputs.
 */

export function NotAvailableBadge() {
  return <Badge variant="outline">Not available yet</Badge>;
}

/** Collapsible card (native details/summary: keyboard and phone friendly, works without JavaScript). */
export function PlanCard({ title, badge, open, children, testId }: { title: string; badge?: ReactNode; open?: boolean; children: ReactNode; testId?: string }) {
  return (
    <details open={open} className="group rounded-xl border" data-testid={testId}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="font-medium">{title}</span>
        <span className="flex items-center gap-2">
          {badge}
          <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
        </span>
      </summary>
      <div className="grid gap-3 border-t px-4 py-3 text-sm">{children}</div>
    </details>
  );
}

/** The event's stages in order, each with its details (when built) and moments. */
export function StageCards({ stages, renderDetails }: { stages: PlanStructure["stages"]; renderDetails?: (stage: PlanStage) => ReactNode }) {
  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages yet.</p>;
  }
  return (
    <ol className="grid gap-2" aria-label="Stages of the event, in order">
      {stages.map((s, index) => (
        <li key={s.id}>
          <PlanCard
            title={`${index + 1}. ${s.label}`}
            testId={`stage-${s.key}`}
            badge={isStageEditor(s.editor) ? <ItemStatus itemId={s.id} /> : <NotAvailableBadge />}
          >
            {isStageEditor(s.editor) && renderDetails ? renderDetails(s) : null}
            {s.moments.length > 0 ? (
              <ul className="grid gap-1.5" aria-label={`Moments in ${s.label}`}>
                {s.moments.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{m.label}</span>
                    <span className="text-xs text-muted-foreground">{m.editor === "stage_details" ? "Included in the details above" : "Not available yet"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {isStageEditor(s.editor)
                ? "Songs, names and pronunciation for this part of the event can't be entered yet and aren't counted in progress."
                : "Details, songs, names and pronunciation for this part of the event can't be entered yet. They aren't counted in progress."}
            </p>
          </PlanCard>
        </li>
      ))}
    </ol>
  );
}

/** Frozen proposal answers from the signed contract, read-only. */
export function AlreadyProvided({ imported, djName, audience }: { imported: Imported; djName: string; audience: "client" | "staff" }) {
  if (!imported || imported.questions.length === 0) {
    return audience === "staff" ? (
      <p className="text-sm text-muted-foreground">No proposal answers to show: the event has no signed contract, or its proposal asked no questions.</p>
    ) : null;
  }
  const captured = new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(imported.captured_at));
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted-foreground">
        {audience === "client"
          ? `You answered these in your proposal. There's no need to enter them again; contact ${djName} if one has changed.`
          : `Copied on ${captured} from the proposal answers behind the signed contract, with their original wording. Read-only: planning never changes the contract.`}
      </p>
      <dl className="grid gap-2">
        {imported.questions.map((q) => (
          <div key={q.key} className="grid gap-0.5 border-b pb-2 last:border-b-0">
            <dt className="text-muted-foreground">{q.prompt}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">{formatImportedAnswer(q, imported.answers)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
