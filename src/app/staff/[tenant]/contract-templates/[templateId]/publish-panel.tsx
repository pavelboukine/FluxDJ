"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { useDraftEditorState } from "@/components/app/draft-version";
import { idleState, type ActionState } from "@/lib/forms";
import { publishContractTemplateVersion } from "../actions";

type Props = {
  slug: string;
  templateId: string;
  versionId: string;
  versionNumber: number;
  version: number;
  isOwner: boolean;
  /** The current client-use statement, shown exactly as the database stores it. */
  statement: { version: string; text: string };
};

/**
 * Publishes the saved draft after confirmation, as DEMO or for client use.
 * Client use needs the owner to check the responsibility statement. Blocked
 * while the editor has unsaved changes.
 */
export function PublishPanel({ slug, templateId, versionId, versionNumber, version, isOwner, statement }: Props) {
  const router = useRouter();
  const editor = useDraftEditorState();
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<"demo" | "client_use">(isOwner ? "client_use" : "demo");
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const unsaved = editor?.unsaved ?? false;

  function publish() {
    const expected = Math.max(version, editor?.version.current ?? version);
    start(async () => {
      const result = await publishContractTemplateVersion(slug, templateId, versionId, expected, usage, usage === "client_use" ? statement.version : null);
      setState(result);
      setConfirming(false);
      setAccepted(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {unsaved ? <p role="status" className="text-amber-700 dark:text-amber-400">Save your changes before publishing.</p> : null}
      {confirming && !unsaved ? (
        <div role="dialog" aria-label="Confirm publishing" className="grid gap-3 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Publish version {versionNumber}?</p>
          <fieldset className="grid gap-2">
            <legend className="mb-1 font-medium">How will this version be used?</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="usage" value="client_use" checked={usage === "client_use"} onChange={() => setUsage("client_use")} disabled={!isOwner} className="mt-0.5 accent-primary" />
              <span>
                <span className="font-medium">For client use.</span> Your own agreement. Clients can sign it online. No DEMO labels.
                {!isOwner ? <span className="block text-muted-foreground">Only the owner can publish an agreement for client use.</span> : null}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="usage" value="demo" checked={usage === "demo"} onChange={() => setUsage("demo")} className="mt-0.5 accent-primary" />
              <span>
                <span className="font-medium">DEMO, for testing.</span> Contracts, the signing page and signed PDFs are labelled
                &quot;DEMO, NOT FOR CLIENT USE&quot; and use test consent wording.
              </span>
            </label>
          </fieldset>
          {usage === "client_use" ? (
            <label className="flex items-start gap-2 rounded-lg border p-3">
              <input type="checkbox" name="client_use_confirmed" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
              <span>{statement.text}</span>
            </label>
          ) : null}
          <p className="text-muted-foreground">
            The saved text is published exactly as shown and can never be changed, and neither can how it is used. Later edits, or a
            different use, need a new version. Publishing sends nothing; contracts already generated keep the version they were made from.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={publish} disabled={pending || (usage === "client_use" && !accepted)}>
              {pending ? "Publishing…" : usage === "client_use" ? `Publish version ${versionNumber} for client use` : `Publish version ${versionNumber} as DEMO`}
            </Button>
            <Button type="button" variant="outline" onClick={() => { setConfirming(false); setAccepted(false); }} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={() => setConfirming(true)} disabled={unsaved}>Publish…</Button>
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}
