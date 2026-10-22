/**
 * The cron route's answer, with the two workers replaced: a run that hit a
 * database problem is never reported as a successful, empty run. The workers
 * themselves are tested against the local database (outbox-reliability and
 * contract-documents integration tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s".repeat(40);
const processOutbox = vi.fn();
const processDocumentJobs = vi.fn();

vi.mock("@/lib/env.server", () => ({ serverEnv: () => ({ OUTBOX_WORKER_SECRET: SECRET }) }));
vi.mock("@/lib/contracts/documents.server", () => ({ processDocumentJobs: (...args: unknown[]) => processDocumentJobs(...args) }));
vi.mock("@/lib/email/outbox.server", async () => {
  class OutboxRunError extends Error {
    constructor(
      readonly result: Record<string, number>,
      readonly problems: string[],
    ) {
      super(`Outbox run incomplete: ${problems.join("; ")}`);
    }
  }
  return {
    OutboxRunError,
    processOutbox: (...args: unknown[]) => processOutbox(...args),
    logOutboxFailure: (where: string, cause: unknown) => console.error(`[outbox] ${where}: ${(cause as Error).message}`),
  };
});

const { GET } = await import("@/app/api/internal/outbox/route");
const { OutboxRunError } = (await import("@/lib/email/outbox.server")) as unknown as {
  OutboxRunError: new (result: Record<string, number>, problems: string[]) => Error;
};

const call = (secret = SECRET) => GET(new Request("http://127.0.0.1:3000/api/internal/outbox", { headers: { authorization: `Bearer ${secret}` } }));
const emails = { claimed: 2, sent: 2, failed: 0, cancelled: 0, unconfirmed: 0 };
const documents = { claimed: 0, committed: 0, reused: 0, failed: 0, paused: 0 };
let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));
  processDocumentJobs.mockReset().mockResolvedValue(documents);
  processOutbox.mockReset().mockResolvedValue(emails);
});
afterEach(() => vi.restoreAllMocks());

describe("outbox cron route", () => {
  it("refuses a wrong secret without running anything", async () => {
    expect((await call("wrong")).status).toBe(404);
    expect(processOutbox).not.toHaveBeenCalled();
    expect(processDocumentJobs).not.toHaveBeenCalled();
  });

  it("answers 200 when both workers completed", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", ...emails, documents });
    expect(logged).toEqual([]);
  });

  it("answers 500 with what was done when an email claim failed", async () => {
    processOutbox.mockRejectedValue(new OutboxRunError(emails, ["Planning invitation emails could not be claimed (XX000)"]));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "error", sent: 2, problems: ["Planning invitation emails could not be claimed (XX000)"], documents });
    expect(logged).toEqual(["[outbox] scheduled run: Outbox run incomplete: Planning invitation emails could not be claimed (XX000)"]);
  });

  it("answers 500 when the PDF worker failed, after still delivering emails", async () => {
    processDocumentJobs.mockRejectedValue(new Error("Could not claim document jobs (XX000)"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "error", ...emails, documents: { error: true } });
    expect(processOutbox).toHaveBeenCalled();
    expect(logged).toEqual(["[outbox] signed PDF worker: Could not claim document jobs (XX000)"]);
  });

  it("answers 500 on any other worker error", async () => {
    processOutbox.mockRejectedValue(new Error("boom"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "error" });
  });
});
