/**
 * Platform operations: the scheduled worker's health, from its own record
 * (private.worker_heartbeats, written at the end of every cron run), and the
 * external heartbeat monitor's URLs. Worker health is about the worker as a
 * whole. An "ok" run can still leave single emails retrying or failed; those
 * keep their own state (Platform → Operations, each business's Emails page).
 */

/** vercel.json schedules /api/internal/outbox every 5 minutes. */
export const WORKER_INTERVAL_MINUTES = 5;
/** Three missed runs: the worker isn't running as scheduled. */
export const WORKER_STALE_MINUTES = 15;

export type WorkerRecord = {
  worker_last_finished_at: string | null;
  worker_last_outcome: string | null;
  worker_last_success_at: string | null;
  worker_last_failure_at: string | null;
  worker_consecutive_failures: number | null;
  worker_last_summary: unknown;
};

export type WorkerHealth = {
  state: "ok" | "failing" | "stale" | "unknown";
  label: string;
  explanation: string;
  attention: boolean;
};

const ago = (iso: string, now: Date) => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
};

const count = (summary: unknown, key: string) => {
  const value = (summary as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

/** The worker's health from its last recorded run. */
export function workerHealth(record: WorkerRecord, now = new Date()): WorkerHealth {
  const finished = record.worker_last_finished_at;
  if (!finished) {
    return {
      state: "unknown",
      label: "No run recorded",
      explanation: "No scheduled run has been recorded yet. The cron records every run from this release on; one should appear within 5 minutes of deploying.",
      attention: false,
    };
  }
  const lastSuccess = record.worker_last_success_at ? `Last successful run: ${ago(record.worker_last_success_at, now)}.` : "No successful run recorded.";
  if (now.getTime() - Date.parse(finished) > WORKER_STALE_MINUTES * 60_000) {
    return {
      state: "stale",
      label: "Not running",
      explanation: `No scheduled run has finished since ${ago(finished, now)} (it runs every ${WORKER_INTERVAL_MINUTES} minutes). Check the cron job and the function logs in Vercel. ${lastSuccess}`,
      attention: true,
    };
  }
  if (record.worker_last_outcome !== "ok") {
    const streak = record.worker_consecutive_failures ?? 1;
    return {
      state: "failing",
      label: "Last run failed",
      explanation: `The last run, ${ago(finished, now)}, hit a database problem${streak > 1 ? ` (${streak} runs in a row)` : ""}. It still did all the other work it could. ${lastSuccess} The function logs name the problem.`,
      attention: true,
    };
  }
  const s = record.worker_last_summary;
  const claimed = count(s, "claimed");
  return {
    state: "ok",
    label: "Running",
    explanation: `Last run ${ago(finished, now)}: ${claimed === 0 ? "no emails were due" : `${claimed} email${claimed === 1 ? "" : "s"} processed, ${count(s, "sent")} sent, ${count(s, "failed")} failed (retried automatically)`}.`,
    attention: false,
  };
}

/**
 * The external monitor's ping URLs for a configured heartbeat URL
 * (Healthchecks.io convention: the URL itself for success, "/fail" appended
 * for a failure; Better Stack heartbeats accept the same). Null when unset
 * or not an https URL.
 */
export function heartbeatUrls(raw: string | undefined): { success: string; failure: string } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const base = url.toString().replace(/\/+$/, "");
    return { success: base, failure: `${base}/fail` };
  } catch {
    return null;
  }
}
