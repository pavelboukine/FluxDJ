import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env.server";
import { processOutbox } from "@/lib/email/outbox.server";
import { processDocumentJobs } from "@/lib/contracts/documents.server";
import { safeEqual } from "@/lib/proposals/tokens.server";

// Rendering a few PDFs plus a batch of emails fits well within a minute.
export const maxDuration = 60;

/**
 * Background worker endpoint. Called by `pnpm outbox:work` locally, or by
 * Vercel Cron every 5 minutes when hosted. Requires
 * "Authorization: Bearer $OUTBOX_WORKER_SECRET"; disabled when unset.
 * Signed-contract PDFs run first (a few per run, each under a renewable
 * lease), so copies queued by a commit are emailed in the same run.
 */
async function run(request: Request) {
  const secret = serverEnv().OUTBOX_WORKER_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !safeEqual(supplied, secret)) return NextResponse.json({ status: "not_found" }, { status: 404 });
  const documents = await processDocumentJobs({ limit: 5 }).catch(() => ({ claimed: 0, committed: 0, reused: 0, failed: 0, error: true }));
  const result = await processOutbox({ limit: 50 });
  return NextResponse.json({ status: "ok", ...result, documents }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
