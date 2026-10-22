import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env.server";
import { logOutboxFailure, OutboxRunError, processOutbox, type OutboxRunResult } from "@/lib/email/outbox.server";
import { processDocumentJobs } from "@/lib/contracts/documents.server";
import { reportScheduledRun } from "@/lib/operations.server";
import { safeEqual } from "@/lib/proposals/tokens.server";
import { createAdminClient } from "@/lib/supabase/admin";

// Rendering a few PDFs plus a batch of emails fits well within a minute.
export const maxDuration = 60;

/**
 * Background worker endpoint. Called by `pnpm outbox:work` locally, or by
 * Vercel Cron every 5 minutes when hosted. Requires
 * "Authorization: Bearer $OUTBOX_WORKER_SECRET"; disabled when unset.
 * Signed-contract PDFs run first (a few per run, each under a renewable
 * lease), so copies queued by a commit are emailed in the same run.
 *
 * A run that hit a database problem answers 500 after doing everything else
 * it could, so a failure never looks like a successful, empty run in the
 * cron logs: the PDF worker failing as a whole, an email claim failing, or an
 * accepted email that couldn't be recorded. Failures of single emails or PDFs
 * stay on their rows (Emails page, contract page) and don't fail the run.
 *
 * Every authorized run is then reported (reportScheduledRun): to the worker's
 * record (Platform → Operations) and to the external heartbeat monitor, which
 * alerts when runs stop or fail.
 */
async function run(request: Request) {
  const secret = serverEnv().OUTBOX_WORKER_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !safeEqual(supplied, secret)) return NextResponse.json({ status: "not_found" }, { status: 404 });
  const headers = { "Cache-Control": "no-store" };
  let healthy = true;
  const documents = await processDocumentJobs({ limit: 5 }).catch((cause: unknown) => {
    healthy = false;
    logOutboxFailure("signed PDF worker", cause);
    return { claimed: 0, committed: 0, reused: 0, failed: 0, paused: 0, error: true };
  });
  let body: Record<string, unknown>;
  let counts: Partial<OutboxRunResult> = {};
  let problems = healthy ? 0 : 1;
  try {
    counts = await processOutbox({ limit: 50 });
    body = { status: healthy ? "ok" : "error", ...counts, documents };
  } catch (cause) {
    healthy = false;
    logOutboxFailure("scheduled run", cause);
    if (cause instanceof OutboxRunError) counts = cause.result;
    problems += cause instanceof OutboxRunError ? cause.problems.length : 1;
    body = { status: "error", ...counts, ...(cause instanceof OutboxRunError ? { problems: cause.problems } : {}), documents };
  }
  await reportScheduledRun(createAdminClient(), { ok: healthy, emails: counts, problems, documentsFailed: documents.failed }).catch((cause: unknown) =>
    logOutboxFailure("run report", cause),
  );
  return NextResponse.json(body, { status: healthy ? 200 : 500, headers });
}

export const GET = run;
export const POST = run;
