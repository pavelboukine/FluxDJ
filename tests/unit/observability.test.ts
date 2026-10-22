import { afterEach, describe, expect, it, vi } from "vitest";
import { errorCode, logEvent, redact } from "@/lib/observability";
import { onRequestError } from "@/instrumentation";

const TOKEN = "Zk3_9aQ-xL2mN8pR4tV6wY0bC1dE5fG7hJ9kL3nP5rS"; // a 43-character link token
const ROW = "3f2b8c1e-9a4d-4c7e-8b2a-1d5e6f7a8b9c";

let lines: string[] = [];
const capture = () => {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, "warn").mockImplementation((line: string) => void lines.push(line));
};
afterEach(() => vi.restoreAllMocks());

describe("redaction", () => {
  it("removes addresses, links, tokens, credentials and codes", () => {
    const text = `Failed for robin.client+tag@example.com at https://fluxdj.com/bouprod/p#${TOKEN} with Bearer sk_live_abcdef123456 code 482913 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig re_123abc456def789`;
    const out = redact(text);
    for (const secret of ["robin.client", "example.com", "fluxdj.com", TOKEN, "sk_live", "482913", "eyJhbGci", "re_123abc"]) expect(out).not.toContain(secret);
    expect(out).toContain("[email]");
    expect(out).toContain("[url]");
  });

  it("keeps what is safe and useful: row ids, error codes, statuses and dates", () => {
    const text = `email ${ROW} was accepted by the provider but could not be recorded as sent (XX000) at 2026-10-22, HTTP 503`;
    expect(redact(text)).toBe(text);
  });

  it("caps the length", () => {
    expect(redact("x".repeat(2000)).length).toBeLessThanOrEqual(501);
  });

  it("gives a code, never a message", () => {
    expect(errorCode({ code: "PGRST202", message: `secret ${TOKEN}` })).toBe("PGRST202");
    expect(errorCode({ digest: "1234567890" })).toBe("1234567890");
    expect(errorCode(new TypeError(`bad ${TOKEN}`))).toBe("TypeError");
    expect(errorCode({ code: "has spaces and @ signs" })).toBe("unknown");
    // A long token-like value is never a code.
    expect(errorCode({ code: TOKEN })).toBe("unknown");
    expect(errorCode(null)).toBe("unknown");
  });
});

describe("structured log lines", () => {
  it("writes one JSON line with fixed fields, redacting the detail", () => {
    capture();
    logEvent({ level: "error", category: "worker", operation: "scheduled run", code: "outbox_run_incomplete", id: ROW, detail: `to client@example.com via https://x.test/#${TOKEN}` });
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({ source: "flux-dj", level: "error", category: "worker", operation: "scheduled run", code: "outbox_run_incomplete", id: ROW });
    expect(Date.parse(event.ts)).not.toBeNaN();
    expect(lines[0]).not.toMatch(/client@example\.com|x\.test|Zk3_/);
  });

  it("drops an id that isn't a UUID, and warns on warn level", () => {
    capture();
    const warn = vi.mocked(console.warn);
    logEvent({ level: "warn", category: "monitoring", operation: "heartbeat", id: "robin@example.com" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[0])).not.toHaveProperty("id");
  });
});

describe("unexpected request errors (instrumentation)", () => {
  const request = { path: `/auth/confirm?token_hash=${TOKEN}&next=%2Fmy`, method: "POST", headers: { authorization: `Bearer ${TOKEN}`, cookie: `sb=${TOKEN}` } };
  const context = { routerKind: "App Router", routePath: "/staff/[tenant]/emails", routeType: "action", renderSource: undefined, revalidateReason: undefined } as const;

  it("logs the route pattern, method, kind and a safe code, never the path, headers or cookies", async () => {
    capture();
    const error = Object.assign(new Error(`Could not load data for robin@example.com (${TOKEN})`), { digest: "2847561093" });
    await onRequestError(error, request, context as never);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({ level: "error", category: "request", operation: "POST /staff/[tenant]/emails (action)", code: "2847561093" });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toMatch(/robin@example\.com|token_hash|authorization|cookie/i);
    // Only the class name: an unexpected message can quote a name or a value no redaction removes.
    expect(event.detail).toBe("Error");
    expect(lines[0]).not.toContain("Could not load data");
  });

  it("never logs a database error's message, which can quote row values", async () => {
    capture();
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint "clients_email" Key (name)=(Robin Smith)'), { code: "23505" });
    await onRequestError(dbError, request, context as never);
    expect(JSON.parse(lines[0])).toMatchObject({ code: "23505", detail: "Error" });
    expect(lines[0]).not.toContain("Robin Smith");
  });

  it.each(["NEXT_REDIRECT;replace;/login;307;", "NEXT_HTTP_ERROR_FALLBACK;404", "DYNAMIC_SERVER_USAGE"])("ignores the navigation signal %s", async (digest) => {
    capture();
    await onRequestError(Object.assign(new Error(digest), { digest }), request, context as never);
    expect(lines).toHaveLength(0);
  });

  it("ignores a visitor leaving before the response finished", async () => {
    capture();
    await onRequestError(Object.assign(new Error("The destination stream closed early."), { digest: "111" }), request, context as never);
    await onRequestError(Object.assign(new Error("aborted"), { name: "AbortError" }), request, context as never);
    await onRequestError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), request, context as never);
    expect(lines).toHaveLength(0);
  });

  it("logs one failure once, even when React reports it from two render phases", async () => {
    capture();
    const error = () => Object.assign(new Error("Cannot read properties of undefined"), { digest: "9988776655" });
    await onRequestError(error(), request, context as never);
    await onRequestError(error(), request, context as never);
    expect(lines).toHaveLength(1);
    await onRequestError(Object.assign(new Error("Another failure"), { digest: "5544332211" }), request, context as never);
    expect(lines).toHaveLength(2);
  });
});
