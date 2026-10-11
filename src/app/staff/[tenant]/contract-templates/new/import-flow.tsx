"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, FileUp, Info } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import { RequestIdField } from "@/components/app/request-id-field";
import { ContractDocument } from "@/components/contract/contract-document";
import type { ImportIssue, ImportResult } from "@/lib/contracts/docx/import.server";
import { cn } from "@/lib/utils";
import { createContractTemplate, importWordDocument } from "../actions";

const MAX_BYTES = 4 * 1024 * 1024;
type Converted = Extract<ImportResult, { ok: true }>;

/**
 * Word import: upload a .docx, review exactly what it became, then create a
 * draft from it. The upload only converts (nothing is saved, the file isn't
 * kept); Cancel or another file leaves nothing behind. Problems that would
 * make the draft wrong block creating it; warnings that need a decision must
 * each be ticked; the rest is information.
 */
export function ImportFlow({ slug, listHref }: { slug: string; listHref: string }) {
  const [result, setResult] = useState<Converted | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  function convert(form: HTMLFormElement) {
    const file = input.current?.files?.[0];
    if (!file) return setError("Choose a Word document (.docx) to import.");
    if (!/\.docx$/i.test(file.name)) return setError("Only Word documents (.docx) can be imported. Save the file as .docx in Word first.");
    if (file.size > MAX_BYTES) return setError("The file is larger than 4 MB. Remove large images from the document (they aren't imported anyway) and try again.");
    setError(null);
    const data = new FormData(form);
    start(async () => {
      let r: ImportResult;
      try {
        r = await importWordDocument(slug, data);
      } catch {
        r = { ok: false, error: "The upload didn't go through. Check your connection, then try again." };
      }
      if (r.ok) {
        setFileName(file.name);
        setResult(r);
        window.scrollTo({ top: 0 });
      } else setError(r.error);
    });
  }

  if (!result) {
    return (
      <section aria-labelledby="upload-heading" className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h2 id="upload-heading" className="text-base font-semibold">Import a Word document</h2>
          <p className="text-sm text-muted-foreground">
            Flux converts your agreement into sections you can edit, and shows you everything it changed or couldn&apos;t keep before anything is
            saved. The wording stays exactly as written. The file itself isn&apos;t stored.
          </p>
        </div>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            convert(e.currentTarget);
          }}
        >
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Word document (.docx, up to 4 MB)</span>
            <input
              ref={input}
              type="file"
              name="file"
              required
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="block w-full max-w-md text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              <FileUp aria-hidden />
              {pending ? "Converting…" : "Convert document"}
            </Button>
            <Link className={buttonVariants({ variant: "ghost" })} href={listHref}>Cancel</Link>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </form>
      </section>
    );
  }

  return <ImportReview slug={slug} listHref={listHref} result={result} fileName={fileName} onRestart={() => setResult(null)} />;
}

function IssueList({ issues, tone }: { issues: ImportIssue[]; tone: "blocking" | "info" }) {
  return (
    <ul className="grid gap-3">
      {issues.map((i) => (
        <li key={i.id} className="grid gap-1 text-sm" data-testid={`issue-${i.id}`}>
          <span className={cn("font-medium", tone === "blocking" && "text-destructive")}>{i.title}</span>
          <span className="text-muted-foreground">{i.detail}</span>
          {i.items?.length ? (
            <ul className="grid list-disc gap-0.5 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
              {i.items.map((item, n) => <li key={n}>{item}</li>)}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ImportReview({ slug, listHref, result, fileName, onRestart }: { slug: string; listHref: string; result: Converted; fileName: string; onRestart: () => void }) {
  const [withExtra, setWithExtra] = useState(false);
  const blocking = result.issues.filter((i) => i.level === "blocking");
  const review = result.issues.filter((i) => i.level === "review");
  const info = result.issues.filter((i) => i.level === "info");
  const sections = withExtra && result.extraSection ? [...result.sections, result.extraSection] : result.sections;
  const s = result.stats;
  const defaultName = fileName.replace(/\.docx$/i, "").trim().slice(0, 200) || result.title.slice(0, 200);

  return (
    <div className="grid gap-6">
      <section aria-labelledby="review-heading" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <h2 id="review-heading" className="text-base font-semibold">Review the import</h2>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {fileName}: nothing has been saved yet. Read the converted agreement below, then create a draft to edit it.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onRestart}>Choose another file</Button>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4" data-testid="import-stats">
          <div><dt className="text-xs text-muted-foreground">Sections</dt><dd className="font-medium">{s.sections}</dd></div>
          <div><dt className="text-xs text-muted-foreground">List items</dt><dd className="font-medium">{s.listItems}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Tables</dt><dd className="font-medium">{s.tables}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Images (not imported)</dt><dd className="font-medium">{s.images}</dd></div>
        </dl>
      </section>

      {blocking.length ? (
        <section role="alert" aria-labelledby="blocking-heading" className="grid gap-3 rounded-xl border border-destructive/50 bg-destructive/5 p-4" data-testid="import-blocking">
          <h2 id="blocking-heading" className="flex items-center gap-2 text-base font-semibold text-destructive">
            <AlertTriangle aria-hidden className="size-4" />
            This document can&apos;t be imported as it is
          </h2>
          <IssueList issues={blocking} tone="blocking" />
          <p className="text-sm">Fix this in Word, save, and choose the file again. Nothing has been saved.</p>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        <div className="grid min-w-0 gap-6">
          {info.length ? (
            <section aria-labelledby="info-heading" className="grid gap-3 rounded-xl border bg-card p-4" data-testid="import-info">
              <h2 id="info-heading" className="flex items-center gap-2 text-base font-semibold">
                <Info aria-hidden className="size-4" />
                Good to know
              </h2>
              <IssueList issues={info} tone="info" />
            </section>
          ) : null}

          {blocking.length ? null : (
            <section aria-labelledby="create-heading" className="grid gap-3 rounded-xl border bg-card p-4" data-testid="import-create">
              <h2 id="create-heading" className="text-base font-semibold">Create the draft</h2>
              <ActionForm action={createContractTemplate.bind(null, slug)} submitLabel="Create draft" pendingLabel="Creating…" secondary={<Link className={buttonVariants({ variant: "ghost" })} href={listHref}>Cancel</Link>}>
                <RequestIdField />
                <input type="hidden" name="start" value="import" />
                <input type="hidden" name="title" value={result.title} />
                {sections.map((sec, n) => (
                  <span key={n} hidden>
                    <input type="hidden" name="heading" value={sec.heading} />
                    <input type="hidden" name="body" value={sec.body} />
                  </span>
                ))}
                <TextField label="Template name" name="name" required maxLength={200} defaultValue={defaultName} hint="Staff see this name. Clients see the document title." />
                {review.length ? (
                  <fieldset className="grid gap-3" data-testid="import-review">
                    <legend className="mb-1 text-sm font-medium">Check these before creating the draft</legend>
                    {review.map((i) => (
                      <div key={i.id} className="grid gap-1.5 rounded-lg border p-3 text-sm" data-testid={`issue-${i.id}`}>
                        <span className="font-medium">{i.title}</span>
                        <span className="text-muted-foreground">{i.detail}</span>
                        {i.items?.length ? (
                          <ul className="grid list-disc gap-0.5 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
                            {i.items.map((item, n) => <li key={n}>{item}</li>)}
                          </ul>
                        ) : null}
                        {i.id === "header-footer" && result.extraSection ? (
                          <label className="flex items-start gap-2">
                            <input type="checkbox" checked={withExtra} onChange={(e) => setWithExtra(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
                            <span>Add this text as a final section, “{result.extraSection.heading}”</span>
                          </label>
                        ) : null}
                        <label className="flex items-start gap-2 font-medium">
                          <input type="checkbox" name="acknowledged" value={i.id} required className="mt-0.5 size-4 shrink-0 accent-primary" />
                          <span>{i.id === "fields" ? "Use these as fields" : "I've checked this"}</span>
                        </label>
                      </div>
                    ))}
                  </fieldset>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  The draft opens in the editor, where you can rename, reorder, remove or add sections and insert fields. Nothing reaches clients
                  until you publish it.
                </p>
              </ActionForm>
            </section>
          )}
        </div>

        <section aria-labelledby="converted-heading" className="grid min-w-0 gap-2">
          <h2 id="converted-heading" className="text-base font-semibold">The converted agreement</h2>
          <p className="text-sm text-muted-foreground">
            Exactly what the draft will contain, as clients would read it. Fields appear as written, for example {"{{client.name}}"}.
            {result.addedHeadings.length ? " “Introduction” is a heading Flux added; the document had none there." : ""}
          </p>
          <div className="rounded-xl border bg-card p-4 sm:p-6" data-testid="import-preview">
            <ContractDocument title={result.title} sections={sections} headingLevel={2} label="Converted agreement" />
          </div>
        </section>
      </div>
    </div>
  );
}
