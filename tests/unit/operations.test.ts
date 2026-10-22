import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatUrls, workerHealth, type WorkerRecord } from "@/lib/operations";

const now = new Date("2026-10-22T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const record = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  worker_last_finished_at: minutesAgo(3),
  worker_last_outcome: "ok",
  worker_last_success_at: minutesAgo(3),
  worker_last_failure_at: null,
  worker_consecutive_failures: 0,
  worker_last_summary: { claimed: 0, sent: 0, failed: 0 },
  ...over,
});

describe("worker health", () => {
  it("a recent run with nothing due is healthy, not a failure", () => {
    expect(workerHealth(record(), now)).toMatchObject({ state: "ok", attention: false, explanation: expect.stringContaining("no emails were due") });
  });

  it("a recent run that processed emails is healthy, even with single emails failing (they are retried)", () => {
    const h = workerHealth(record({ worker_last_summary: { claimed: 4, sent: 3, failed: 1 } }), now);
    expect(h).toMatchObject({ state: "ok", attention: false });
    expect(h.explanation).toContain("4 emails processed, 3 sent, 1 failed (retried automatically)");
  });

  it("a worker-level problem needs attention, with the streak and the last success", () => {
    const h = workerHealth(record({ worker_last_outcome: "error", worker_consecutive_failures: 3, worker_last_success_at: minutesAgo(20), worker_last_failure_at: minutesAgo(2) }), now);
    expect(h).toMatchObject({ state: "failing", attention: true });
    expect(h.explanation).toContain("3 runs in a row");
    expect(h.explanation).toContain("Last successful run: 20 minutes ago");
  });

  it("no run for more than three intervals: not running, whatever the last outcome was", () => {
    expect(workerHealth(record({ worker_last_finished_at: minutesAgo(16) }), now)).toMatchObject({ state: "stale", attention: true });
    expect(workerHealth(record({ worker_last_finished_at: minutesAgo(14) }), now)).toMatchObject({ state: "ok" });
    expect(workerHealth(record({ worker_last_finished_at: minutesAgo(60 * 30), worker_last_outcome: "error" }), now)).toMatchObject({ state: "stale" });
  });

  it("no record yet is unknown, not an alarm", () => {
    expect(workerHealth(record({ worker_last_finished_at: null, worker_last_outcome: null, worker_last_success_at: null }), now)).toMatchObject({ state: "unknown", attention: false });
  });
});

describe("heartbeat URLs", () => {
  it("success is the URL itself; failure appends /fail (Healthchecks.io and Better Stack convention)", () => {
    expect(heartbeatUrls("https://hc-ping.com/abc-123/")).toEqual({ success: "https://hc-ping.com/abc-123", failure: "https://hc-ping.com/abc-123/fail" });
  });

  it.each([undefined, "", "http://hc-ping.com/abc", "not a url", "https://user:pass@hc-ping.com/abc"])("refuses %s", (raw) => {
    expect(heartbeatUrls(raw)).toBeNull();
  });
});

describe("reporting a scheduled run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@/lib/env.server");
  });

  async function load(heartbeat?: string) {
    vi.resetModules();
    vi.doMock("@/lib/env.server", () => ({ serverEnv: () => ({ MONITOR_HEARTBEAT_URL: heartbeat }) }));
    return (await import("@/lib/operations.server")).reportScheduledRun;
  }
  const admin = (error: unknown = null) => ({ rpc: vi.fn(async () => ({ data: null, error })) });
  const run = { ok: true, emails: { claimed: 2, sent: 2, failed: 0, cancelled: 0, unconfirmed: 0 }, problems: 0, documentsFailed: 0 };

  it("records the run (counts only) and pings success", async () => {
    const report = await load("https://hc-ping.com/abc");
    const db = admin();
    const fetcher = vi.fn(async () => new Response("OK"));
    await report(db as never, run, fetcher as never);
    expect(db.rpc).toHaveBeenCalledWith("record_worker_run", expect.objectContaining({ p_worker: "outbox_cron", p_ok: true, p_claimed: 2, p_sent: 2 }));
    expect(fetcher).toHaveBeenCalledWith("https://hc-ping.com/abc", expect.objectContaining({ method: "POST", body: expect.stringContaining("outcome=ok claimed=2") }));
  });

  it("pings the failure URL for a failed run", async () => {
    const report = await load("https://hc-ping.com/abc");
    const fetcher = vi.fn(async () => new Response("OK"));
    await report(admin() as never, { ...run, ok: false, problems: 1 }, fetcher as never);
    expect(fetcher).toHaveBeenCalledWith("https://hc-ping.com/abc/fail", expect.anything());
  });

  it("never pings without a configured URL", async () => {
    const report = await load(undefined);
    const fetcher = vi.fn();
    await report(admin() as never, run, fetcher as never);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pings the monitor even when recording the run throws (the two reports are independent)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = await load("https://heartbeat.invalid/check");
    const db = { rpc: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) };
    const fetcher = vi.fn(async () => new Response("OK"));
    await expect(report(db as never, { ...run, ok: false, problems: 1 }, fetcher as never)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("https://heartbeat.invalid/check/fail", expect.anything());
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "TypeError"],
    ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "TimeoutError"],
    ["a non-successful response", async () => new Response("down", { status: 503 }), "503"],
  ])("survives %s: logged by code only, never the URL, no retry", async (_label, respond, code) => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => void lines.push(line));
    const report = await load("https://heartbeat.invalid/secret-check-uuid");
    const fetcher = vi.fn(respond);
    await expect(report(admin() as never, run, fetcher as never)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A bounded wait: the request carries an abort signal (5 seconds).
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ category: "monitoring", operation: "heartbeat", code });
    expect(lines[0]).not.toMatch(/heartbeat\.invalid|secret-check-uuid/);
  });

  it("never fails the run: a recording error, an unreachable monitor or a bad URL is only logged", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => void lines.push(line));
    const report = await load("https://hc-ping.com/abc");
    await expect(report(admin({ code: "57014" }) as never, run, vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as never)).resolves.toBeUndefined();
    expect(lines.map((l) => JSON.parse(l).operation)).toEqual(["record worker run", "heartbeat"]);
    const bad = await load("http://insecure.example/abc");
    lines.length = 0;
    await bad(admin() as never, run, vi.fn() as never);
    expect(JSON.parse(lines[0])).toMatchObject({ operation: "heartbeat", code: "invalid_url" });
  });
});
