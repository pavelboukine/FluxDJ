/**
 * The worker's record end to end against the LOCAL Supabase stack: the cron
 * route's report (reportScheduledRun, with the real service-role client)
 * reaches Platform → Operations for a real platform administrator's session,
 * and not for anyone else. The route itself isn't called here: it claims
 * every business's emails, which a test must never do.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// A fake monitor, set before the first serverEnv() read: these tests can never ping a real check,
// whatever the local .env.local says. Restored afterwards (process.env is shared between test files).
const FAKE_HEARTBEAT = "https://heartbeat.invalid/it-check";
const previousHeartbeat = process.env.MONITOR_HEARTBEAT_URL;
process.env.MONITOR_HEARTBEAT_URL = FAKE_HEARTBEAT;
import { reportScheduledRun } from "@/lib/operations.server";
import { workerHealth } from "@/lib/operations";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";
import { adminClient, signedInUser, type Db } from "./support/fixtures";

let admin: Db;
let operator: Db;
let outsider: Db;
const operatorEmail = `it-ops-op-${randomUUID().slice(0, 8)}@example.test`;

const summary = async (db: Db) => {
  const { data, error } = await db.rpc("platform_operations_summary").single();
  if (error) throw error;
  return data;
};
const run = (ok: boolean, problems = 0) => ({ ok, emails: { claimed: 3, sent: ok ? 3 : 1, failed: ok ? 0 : 2, cancelled: 0, unconfirmed: 0 }, problems, documentsFailed: 0 });

describe("platform operations (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    operator = (await signedInUser(admin, operatorEmail)).db;
    outsider = (await signedInUser(admin, `it-ops-out-${randomUUID().slice(0, 8)}@example.test`)).db;
    grantPlatformAdminLocally(operatorEmail);
  });

  afterAll(() => {
    revokePlatformAdminLocally(operatorEmail);
    if (previousHeartbeat === undefined) delete process.env.MONITOR_HEARTBEAT_URL;
    else process.env.MONITOR_HEARTBEAT_URL = previousHeartbeat;
  });

  const pings: string[] = [];
  const fakeMonitor = (async (url: string | URL | Request) => {
    pings.push(String(url));
    return new Response("OK");
  }) as typeof fetch;

  it("records failing and recovered runs, as the operator sees them, and pings the monitor for each", async () => {
    await reportScheduledRun(admin, run(false, 1), fakeMonitor);
    await reportScheduledRun(admin, run(false, 2), fakeMonitor);
    let s = await summary(operator);
    expect(s).toMatchObject({ worker_last_outcome: "error", worker_consecutive_failures: 2, window_days: 30, grace_minutes: 15 });
    expect(workerHealth(s, new Date(s.checked_at))).toMatchObject({ state: "failing", attention: true });

    await reportScheduledRun(admin, run(true), fakeMonitor);
    expect(pings).toEqual([`${FAKE_HEARTBEAT}/fail`, `${FAKE_HEARTBEAT}/fail`, FAKE_HEARTBEAT]);
    s = await summary(operator);
    expect(s).toMatchObject({ worker_last_outcome: "ok", worker_consecutive_failures: 0, worker_last_summary: { claimed: 3, sent: 3, failed: 0, problems: 0 } });
    expect(s.worker_last_failure_at).not.toBeNull();
    expect(workerHealth(s, new Date(s.checked_at))).toMatchObject({ state: "ok", attention: false });
  });

  it("is refused to anyone who isn't a platform administrator", async () => {
    const { error } = await outsider.rpc("platform_operations_summary").single();
    expect(error?.code).toBe("42501");
    const { error: listError } = await outsider.rpc("platform_email_issues", { p_limit: 5 });
    expect(listError?.code).toBe("42501");
    // Signed-in users can't write the worker's record either.
    const { error: writeError } = await outsider.rpc("record_worker_run", { p_worker: "outbox_cron", p_ok: true });
    expect(writeError?.code).toBe("42501");
  });
});
