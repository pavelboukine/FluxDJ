"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { retryEmail } from "../../emails/actions";
import { generateSignedPdf, sendSignedCopies } from "../actions";

export type PdfState =
  | { kind: "ready"; pdfSha256: string; byteSize: number; generatedAt: string }
  | { kind: "pending" | "running"; attempts: number; lastError: string | null }
  | { kind: "failed"; attempts: number; lastError: string | null }
  | { kind: "none" };

export type Delivery = { id: string; role: "client" | "business"; email: string; status: string; lastError: string | null; sentAt: string | null };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/**
 * Staff controls for the signed PDF and the signed-copy emails. Generating
 * never emails anyone; sending requires confirming both recipients. Retries
 * always reuse the same committed PDF.
 */
export function SignedDocumentPanel(props: {
  slug: string;
  contractId: string;
  pdf: PdfState;
  deliveries: Delivery[];
  recipients: { role: "client" | "business"; email: string }[];
  archived: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idleState);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const run = (action: () => Promise<ActionState>) =>
    start(async () => {
      const result = await action();
      setState(result);
      setConfirming(false);
      router.refresh();
    });

  const { pdf } = props;
  const delivered = new Map(props.deliveries.map((d) => [d.role, d]));
  const canSend = pdf.kind === "ready" && !props.archived && props.recipients.some((r) => !["sent", "pending", "sending"].includes(delivered.get(r.role)?.status ?? ""));

  return (
    <div className="grid gap-4 text-sm">
      {pdf.kind === "ready" ? (
        <div className="grid gap-2">
          <a className={buttonVariants({ className: "justify-self-start" })} href={`/staff/${props.slug}/contracts/${props.contractId}/signed-pdf`}>
            Download signed PDF
          </a>
          <dl className="grid gap-1 text-xs [overflow-wrap:anywhere]">
            <div><dt className="text-muted-foreground">Generated</dt><dd>{fmt(pdf.generatedAt)} · {(pdf.byteSize / 1024).toFixed(0)} KB</dd></div>
            <div>
              <dt className="text-muted-foreground">Final PDF file SHA-256</dt>
              <dd className="font-mono">{pdf.pdfSha256}</dd>
              <dd className="text-muted-foreground">Of the exact downloadable file. Different from the contract content SHA-256.</dd>
            </div>
          </dl>
        </div>
      ) : pdf.kind === "none" ? (
        <div className="grid gap-2">
          <p>This contract was signed before signed PDFs existed. Generating it sends no email.</p>
          <Button type="button" className="justify-self-start" disabled={pending} onClick={() => run(() => generateSignedPdf(props.slug, props.contractId))}>
            {pending ? "Generating…" : "Generate signed PDF"}
          </Button>
        </div>
      ) : pdf.kind === "failed" ? (
        <div className="grid gap-2">
          <p role="alert" className="text-destructive">PDF generation failed after {pdf.attempts} attempts: {pdf.lastError ?? "unknown error"}</p>
          <p className="text-muted-foreground">The signature is safe and unchanged. Retrying reuses the same PDF if one was already stored.</p>
          <Button type="button" className="justify-self-start" disabled={pending} onClick={() => run(() => generateSignedPdf(props.slug, props.contractId))}>
            {pending ? "Retrying…" : "Retry PDF generation"}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <p role="status">The signed PDF is being generated{pdf.attempts > 1 ? ` (attempt ${pdf.attempts})` : ""}.</p>
          {pdf.lastError ? <p className="text-amber-700 dark:text-amber-400">Last attempt: {pdf.lastError} It will be retried automatically.</p> : null}
          <Button type="button" variant="outline" className="justify-self-start" disabled={pending} onClick={() => run(() => generateSignedPdf(props.slug, props.contractId))}>
            {pending ? "Working…" : "Generate now"}
          </Button>
        </div>
      )}

      <div className="grid gap-2">
        <h3 className="font-medium">Signed copies by email</h3>
        <ul className="grid gap-1">
          {props.recipients.map((r) => {
            const d = delivered.get(r.role);
            return (
              <li key={r.role} className="flex flex-wrap items-center gap-2">
                <span>
                  {r.role === "client" ? "Client" : "Business"}: {r.email} ·{" "}
                  {d ? (d.status === "sent" && d.sentAt ? `sent ${fmt(d.sentAt)}` : d.status) : "not sent"}
                </span>
                {d?.status === "failed" ? (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => retryEmail(props.slug, d.id))}>
                    Retry this email
                  </Button>
                ) : null}
                {d?.lastError && d.status !== "sent" ? <span className="w-full text-xs text-destructive">{d.lastError}</span> : null}
              </li>
            );
          })}
        </ul>
        {props.archived ? <p className="text-muted-foreground">The event is archived, so no copies are sent. The PDF is kept.</p> : null}
        {canSend && !confirming ? (
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setConfirming(true)}>
            Send signed copies…
          </Button>
        ) : null}
        {confirming ? (
          <div role="dialog" aria-label="Confirm sending signed copies" className="grid gap-2 rounded-xl border-2 border-primary/40 p-3">
            <p className="font-medium">Email the signed PDF to:</p>
            <ul className="list-disc pl-5">
              {props.recipients.map((r) => (
                <li key={r.role}>{r.role === "client" ? "Client" : "Business"}: {r.email}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">Copies already delivered are not sent again.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending}
                onClick={() => run(() => sendSignedCopies(props.slug, props.contractId, props.recipients.map((r) => r.email)))}
              >
                {pending ? "Sending…" : "Send signed copies"}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <FormMessage state={state} />
    </div>
  );
}
