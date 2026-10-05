import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { SIGNATURE_BUCKET } from "./signing";
import { buildSignedContractPdfData } from "./pdf/data";
import { PDF_RENDERER, renderSignedContractPdf } from "./pdf/render.server";

type Db = SupabaseClient<Database>;

export const DOCUMENT_BUCKET = "contract-documents";
const MAX_PDF_BYTES = 10 * 1024 * 1024;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A stored file that no longer matches its recorded hash. Never retried automatically. */
export class IntegrityError extends Error {
  readonly permanent = true;
}

export type DocumentRef = { storage_path: string; pdf_sha256: string; byte_size: number };

/**
 * Reads a committed PDF and checks it against the recorded size and SHA-256
 * before anyone receives it. A mismatch throws IntegrityError: a damaged or
 * altered file is never downloaded or attached.
 */
export async function readVerifiedDocument(admin: Db, doc: DocumentRef): Promise<Buffer> {
  const { data, error } = await admin.storage.from(DOCUMENT_BUCKET).download(doc.storage_path);
  if (error || !data) throw new Error("The signed PDF could not be read from storage.");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length !== doc.byte_size || sha256(bytes) !== doc.pdf_sha256) {
    throw new IntegrityError("The stored signed PDF does not match its recorded SHA-256. It was not delivered.");
  }
  return bytes;
}

export type DocumentRunResult = { claimed: number; committed: number; reused: number; failed: number };

type Hooks = {
  /** Replaces rendering (tests simulate renderer failures). */
  render?: typeof renderSignedContractPdf;
  /** Replaces the Storage upload (tests simulate outages). */
  upload?: (path: string, bytes: Buffer) => Promise<{ error: unknown }>;
  /** Runs between upload and commit (tests simulate crashes and races). */
  beforeCommit?: (job: { job_id: string; contract_id: string }) => Promise<void>;
};

/**
 * Generates due signed-contract PDFs.
 *
 * For each claimed job (with a lease that expires if this worker dies):
 *  1. Load the frozen contract and the signing evidence.
 *  2. Download the signature image and check it against its recorded SHA-256
 *     (a mismatch fails the job permanently and visibly; nothing is rendered).
 *  3. Render from the frozen data only, hash the exact final bytes.
 *  4. Upload to a fresh unique path (never overwriting anything).
 *  5. Commit atomically. "exists" means another worker's PDF is canonical:
 *     this upload is removed and the canonical PDF is reused.
 * A commit whose outcome is unknown (lost response) keeps its upload: it may
 * be canonical. Anything left unreferenced is an orphan, listed by
 * private.contract_document_orphans; the lease expiry lets another worker
 * retry. The signature itself is never touched by any of this.
 */
export async function processDocumentJobs(
  options: { admin?: Db; tenantId?: string; contractId?: string; limit?: number; leaseSeconds?: number; hooks?: Hooks } = {},
): Promise<DocumentRunResult> {
  const admin = options.admin ?? createAdminClient();
  const result: DocumentRunResult = { claimed: 0, committed: 0, reused: 0, failed: 0 };
  const { data: jobs, error } = await admin.rpc("claim_document_jobs", {
    p_limit: options.limit ?? 3,
    p_lease_seconds: options.leaseSeconds ?? 120,
    p_tenant_id: options.tenantId,
    // Only this contract's job (just signed or requested); other jobs wait for the scheduled worker.
    p_contract_id: options.contractId,
  });
  if (error) throw new Error(`Could not claim document jobs (${error.code ?? "error"})`);

  for (const job of jobs ?? []) {
    result.claimed += 1;
    try {
      const outcome = await generate(admin, job, options.hooks);
      result[outcome] += 1;
    } catch (cause) {
      const permanent = cause instanceof IntegrityError;
      const message = cause instanceof Error ? cause.message.slice(0, 300) : "Unknown PDF generation error";
      await admin.rpc("fail_document_job", { p_job_id: job.job_id, p_lease_token: job.lease_token, p_error: message, p_permanent: permanent });
      result.failed += 1;
    }
  }
  return result;
}

async function generate(
  admin: Db,
  job: { job_id: string; lease_token: string; tenant_id: string; contract_id: string },
  hooks?: Hooks,
): Promise<"committed" | "reused"> {
  // Already committed (e.g. a retry after a lost response): reuse it.
  const { data: existing } = await admin
    .from("contract_documents")
    .select("storage_path, pdf_sha256, byte_size, signature_sha256")
    .eq("contract_id", job.contract_id)
    .eq("kind", "signed_contract")
    .maybeSingle();
  if (existing) {
    await commit(admin, job.job_id, existing.storage_path, existing.pdf_sha256, existing.byte_size, existing.signature_sha256);
    return "reused";
  }

  const [{ data: contract, error: cErr }, { data: signature, error: sErr }] = await Promise.all([
    admin
      .from("contracts")
      .select("id, tenant_id, status, signing_mode, consent_version, content_sha256, currency, total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, commercial_snapshot, party_snapshot")
      .eq("id", job.contract_id)
      .single(),
    admin
      .from("contract_signatures")
      .select("typed_name, signer_email, signed_at, signature_path, signature_sha256, signature_bytes, content_sha256, consent_version, consent_text, user_agent, client_ip, client_ip_source")
      .eq("contract_id", job.contract_id)
      .single(),
  ]);
  if (cErr || sErr || !contract || !signature) throw new Error("The signed contract or its signature record could not be loaded.");

  const { data: blob, error: dErr } = await admin.storage.from(SIGNATURE_BUCKET).download(signature.signature_path);
  if (dErr || !blob) throw new Error("The signature image could not be read from storage.");
  const png = Buffer.from(await blob.arrayBuffer());
  if (png.length !== signature.signature_bytes || sha256(png) !== signature.signature_sha256) {
    throw new IntegrityError("The stored signature image does not match its recorded SHA-256. The PDF was not generated.");
  }

  const data = buildSignedContractPdfData(contract, signature);
  const pdf = await (hooks?.render ?? renderSignedContractPdf)(data, png);
  if (pdf.length > MAX_PDF_BYTES) throw new Error("The rendered PDF is larger than 10 MB.");
  const pdfSha = sha256(pdf);

  const path = `${job.tenant_id}/${job.contract_id}/${randomUUID()}.pdf`;
  const upload =
    hooks?.upload ?? (async (p: string, bytes: Buffer) => admin.storage.from(DOCUMENT_BUCKET).upload(p, bytes, { contentType: "application/pdf", upsert: false }));
  const uploaded = await upload(path, pdf).catch((e: unknown) => ({ error: e }));
  if (uploaded.error) throw new Error("The signed PDF could not be stored. It will be retried.");

  await hooks?.beforeCommit?.(job);
  const outcome = await commit(admin, job.job_id, path, pdfSha, pdf.length, signature.signature_sha256);
  if (outcome.status === "exists") {
    // Another worker's PDF is canonical; this upload is unused.
    await admin.storage.from(DOCUMENT_BUCKET).remove([path]).catch(() => undefined);
    return "reused";
  }
  return "committed";
}

async function commit(admin: Db, jobId: string, path: string, pdfSha: string, size: number, signatureSha: string) {
  const { data, error } = await admin.rpc("commit_contract_document", {
    p_job_id: jobId,
    p_storage_path: path,
    p_pdf_sha256: pdfSha,
    p_byte_size: size,
    p_signature_sha256: signatureSha,
    p_renderer: PDF_RENDERER,
  });
  // Unknown outcome or a definite refusal: the upload is kept either way (it
  // may be canonical); the job is retried and the next attempt finds out.
  if (error) throw new Error(`The signed PDF could not be recorded (${error.message.slice(0, 200)}).`);
  return data as { status: "committed" | "exists"; document_id: string; storage_path?: string };
}

/**
 * Processes one contract's PDF job right away (after signing or a staff
 * request), swallowing errors (they are recorded on the job). Other tenants'
 * backlog never delays it; if another worker holds the job, nothing is done
 * here and that worker (or the scheduled one) finishes it.
 */
export async function processContractPdfQuietly(contractId: string): Promise<void> {
  try {
    await processDocumentJobs({ contractId, limit: 1 });
  } catch {
    // The scheduled worker or the staff retry control will pick the job up.
  }
}
