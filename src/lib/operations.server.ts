import "server-only";
import { serverEnv } from "@/lib/env.server";
import { errorCode, logEvent } from "@/lib/observability";
import { heartbeatUrls } from "@/lib/operations";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { OutboxRunResult } from "@/lib/email/outbox.server";

type Admin = ReturnType<typeof createAdminClient>;

export type ScheduledRun = {
  ok: boolean;
  emails: Partial<OutboxRunResult>;
  problems: number;
  documentsFailed: number;
};

/**
 * Reports a finished scheduled run, in two independent places:
 *  - the worker's record in the database (Platform → Operations), counts only;
 *  - the external heartbeat monitor, if MONITOR_HEARTBEAT_URL is set. It
 *    alerts when pings stop (the worker isn't running) or report a failure,
 *    without depending on Flux's own email delivery.
 * Neither can fail the run; a failure to report is logged.
 */
export async function reportScheduledRun(admin: Admin, run: ScheduledRun, fetcher: typeof fetch = fetch): Promise<void> {
  const e = run.emails;
  // The two reports are independent: the external monitor is pinged even when the database can't be reached.
  try {
    const { error } = await admin.rpc("record_worker_run", {
      p_worker: "outbox_cron",
      p_ok: run.ok,
      p_claimed: e.claimed ?? 0,
      p_sent: e.sent ?? 0,
      p_failed: e.failed ?? 0,
      p_cancelled: e.cancelled ?? 0,
      p_unconfirmed: e.unconfirmed ?? 0,
      p_problems: run.problems,
      p_documents_failed: run.documentsFailed,
    });
    if (error) logEvent({ level: "warn", category: "monitoring", operation: "record worker run", code: errorCode(error) });
  } catch (cause) {
    logEvent({ level: "warn", category: "monitoring", operation: "record worker run", code: errorCode(cause) });
  }

  const raw = serverEnv().MONITOR_HEARTBEAT_URL;
  const urls = heartbeatUrls(raw);
  if (!urls) {
    if (raw) logEvent({ level: "warn", category: "monitoring", operation: "heartbeat", code: "invalid_url", detail: "MONITOR_HEARTBEAT_URL must be an https URL" });
    return;
  }
  try {
    // The body is counts only; monitors show it next to the ping.
    const body = `outcome=${run.ok ? "ok" : "error"} claimed=${e.claimed ?? 0} sent=${e.sent ?? 0} failed=${e.failed ?? 0} problems=${run.problems} documents_failed=${run.documentsFailed}`;
    const response = await fetcher(run.ok ? urls.success : urls.failure, { method: "POST", body, signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!response.ok) logEvent({ level: "warn", category: "monitoring", operation: "heartbeat", code: String(response.status) });
  } catch (cause) {
    logEvent({ level: "warn", category: "monitoring", operation: "heartbeat", code: errorCode(cause) });
  }
}
