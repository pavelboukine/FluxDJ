import { formatImportedAnswer, type Imported } from "@/lib/planning/view";

/** Read-only pieces of a plan shared by the client and staff pages. */

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
