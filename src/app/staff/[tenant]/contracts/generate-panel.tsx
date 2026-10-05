"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, selectClass } from "@/components/app/fields";
import type { MissingItem } from "@/lib/contracts/content";
import { generateContract } from "./actions";

type VersionOption = { id: string; label: string; needsBalanceDueDate: boolean };

type Props = {
  slug: string;
  approvalId: string;
  versions: VersionOption[];
  defaultVersionId: string | null;
  currentDraft: { id: string; label: string; signable: boolean } | null;
  /** Active versions published before usage modes, left out of the list. */
  legacyHidden: number;
};

/**
 * Generates the contract draft for an approved proposal. Replacing an
 * existing draft always needs an explicit confirmation. The server makes
 * repeated clicks safe: an identical request returns the existing draft.
 */
export function GenerateContractPanel({ slug, approvalId, versions, defaultVersionId, currentDraft, legacyHidden }: Props) {
  const router = useRouter();
  const [versionId, setVersionId] = useState(defaultVersionId ?? versions[0]?.id ?? "");
  const [balanceDueDate, setBalanceDueDate] = useState("");
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  const [missing, setMissing] = useState<MissingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const version = versions.find((v) => v.id === versionId);

  function run(replaceContractId: string | null) {
    setError(null);
    setMissing([]);
    start(async () => {
      const result = await generateContract(slug, approvalId, {
        templateVersionId: versionId,
        // Only sent when the chosen version asks for it; the server rejects it otherwise.
        balanceDueDate: version?.needsBalanceDueDate ? balanceDueDate : "",
        replaceContractId,
      });
      switch (result.status) {
        case "created":
        case "replayed":
          setConfirmReplace(null);
          router.push(`/staff/${slug}/contracts/${result.contractId}`);
          break;
        case "draft_exists":
          setConfirmReplace(result.contractId);
          break;
        case "incomplete":
          setConfirmReplace(null);
          setMissing(result.missing);
          break;
        case "error":
          setConfirmReplace(null);
          setError(result.message);
          break;
      }
    });
  }

  const legacyNote =
    legacyHidden > 0 ? (
      <p className="text-sm text-muted-foreground">
        {legacyHidden} version(s) published before agreements could be approved for client use aren&apos;t listed. To use one, open its
        template, start a new draft version and publish it for client use.{" "}
        <Link className="underline" href={`/staff/${slug}/contract-templates`}>Contract templates</Link>
      </p>
    ) : null;

  if (versions.length === 0) {
    return (
      <div className="grid gap-2 text-sm">
        <p>
          Publish a contract template version for client use (or as DEMO for testing) first.{" "}
          <Link className="underline" href={`/staff/${slug}/contract-templates`}>Contract templates</Link>
        </p>
        {legacyNote}
        {currentDraft && !currentDraft.signable ? (
          <p>
            The current draft, <Link className="underline" href={`/staff/${slug}/contracts/${currentDraft.id}`}>{currentDraft.label}</Link>, can&apos;t be
            signed online. Regenerate it once a version is published.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-sm">
      {currentDraft ? (
        <p>
          Current draft: <Link className="underline" href={`/staff/${slug}/contracts/${currentDraft.id}`}>{currentDraft.label}</Link>
          {!currentDraft.signable ? (
            <span className="block text-amber-700 dark:text-amber-400">
              It was generated from a version published before agreements could be approved for client use, so it can&apos;t be sent or
              signed. Regenerate it from a version published for client use.
            </span>
          ) : null}
        </p>
      ) : null}
      {legacyNote}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Template version" htmlFor="template_version_id">
          <select id="template_version_id" className={selectClass} value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={pending}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Balance due date"
          htmlFor="balance_due_date"
          hint={version?.needsBalanceDueDate ? "Required by this template. Nothing is assumed." : "This template doesn't use a balance due date."}
        >
          <Input
            id="balance_due_date"
            type="date"
            value={balanceDueDate}
            onChange={(e) => setBalanceDueDate(e.target.value)}
            disabled={pending || !version?.needsBalanceDueDate}
          />
        </Field>
      </div>

      {confirmReplace ? (
        <div role="dialog" aria-label="Confirm replacing the draft" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Replace the current contract draft?</p>
          <p className="text-muted-foreground">
            A new draft is generated from the chosen version and today&apos;s client, event and business details. The current draft is
            kept as history, marked replaced, and can no longer be used. Nothing is sent to the client.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(confirmReplace)} disabled={pending}>{pending ? "Generating…" : "Replace draft"}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirmReplace(null)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            disabled={pending || !versionId}
            onClick={() => (currentDraft ? setConfirmReplace(currentDraft.id) : run(null))}
          >
            {pending ? "Generating…" : currentDraft ? "Regenerate draft…" : "Generate contract draft"}
          </Button>
        </div>
      )}

      {missing.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
          <p className="font-medium">Complete this information first. Nothing was generated.</p>
          <ul className="list-disc pl-5">
            {missing.map((m) => <li key={m.key}>{m.hint}</li>)}
          </ul>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  );
}
