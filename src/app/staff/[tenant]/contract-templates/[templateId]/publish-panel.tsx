"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { useDraftEditorState } from "@/components/app/draft-version";
import { idleState, type ActionState } from "@/lib/forms";
import { publishContractTemplateVersion } from "../actions";

/** Publishes the saved draft after confirmation. Blocked while the editor has unsaved changes. */
export function PublishPanel({ slug, templateId, versionId, versionNumber, version }: { slug: string; templateId: string; versionId: string; versionNumber: number; version: number }) {
  const router = useRouter();
  const editor = useDraftEditorState();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const unsaved = editor?.unsaved ?? false;

  function publish() {
    const expected = Math.max(version, editor?.version.current ?? version);
    start(async () => {
      const result = await publishContractTemplateVersion(slug, templateId, versionId, expected);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {unsaved ? <p role="status" className="text-amber-700 dark:text-amber-400">Save your changes before publishing.</p> : null}
      {confirming && !unsaved ? (
        <div role="dialog" aria-label="Confirm publishing" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Publish version {versionNumber}?</p>
          <p className="text-muted-foreground">
            The saved text is published exactly as shown and can never be changed. Later edits create a new version. Contracts
            already generated keep the version they were made from.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={publish} disabled={pending}>{pending ? "Publishing…" : `Publish version ${versionNumber}`}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
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
