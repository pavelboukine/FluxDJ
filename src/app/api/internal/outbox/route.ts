import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env.server";
import { processOutbox } from "@/lib/email/outbox.server";
import { safeEqual } from "@/lib/proposals/tokens.server";

/**
 * Outbox worker endpoint. Called by `pnpm outbox:work` locally, or by a
 * scheduled job (e.g. Vercel Cron) when hosted. Requires
 * "Authorization: Bearer $OUTBOX_WORKER_SECRET"; disabled when unset.
 */
async function run(request: Request) {
  const secret = serverEnv().OUTBOX_WORKER_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !safeEqual(supplied, secret)) return NextResponse.json({ status: "not_found" }, { status: 404 });
  const result = await processOutbox({ limit: 50 });
  return NextResponse.json({ status: "ok", ...result }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = run;
export const POST = run;
