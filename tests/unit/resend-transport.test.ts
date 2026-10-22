import { afterEach, describe, expect, it, vi } from "vitest";
import { IdempotencyConflictError, ResendTransport, type EmailMessage } from "@/lib/email/transport.server";

const message: EmailMessage = {
  fromName: "BOUPROD via Flux DJ",
  fromAddress: "proposals@fluxdj.local",
  to: "client@example.test",
  replyTo: null,
  subject: "Your proposal",
  text: "Open it: https://fluxdj.local/bouprod/p#SECRET-TOKEN",
  html: "<a href='https://fluxdj.local/bouprod/p#SECRET-TOKEN'>Open</a>",
};

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Resend transport", () => {
  it("sends the row's idempotency key as the Idempotency-Key header, and none without one", async () => {
    const fetchMock = respond(200, { id: "re_1" });
    await expect(new ResendTransport("key").send({ ...message, idempotencyKey: "flux-proposal-sent-1" })).resolves.toEqual({ id: "re_1" });
    await new ResendTransport("key").send(message);
    const headers = fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(headers[0]["Idempotency-Key"]).toBe("flux-proposal-sent-1");
    expect(headers[1]).not.toHaveProperty("Idempotency-Key");
  });

  it.each(["invalid_idempotent_request", "concurrent_idempotent_requests"])("names an idempotency refusal (%s) by its code", async (name) => {
    respond(409, { statusCode: 409, name, message: `Details about ${message.to}` });
    await expect(new ResendTransport("key").send({ ...message, idempotencyKey: "k" })).rejects.toThrow(`Resend responded 409 (${name})`);
  });

  it("only a changed repeat under a used key is an idempotency conflict (an earlier attempt may have been delivered)", async () => {
    respond(409, { name: "invalid_idempotent_request" });
    await expect(new ResendTransport("key").send(message)).rejects.toBeInstanceOf(IdempotencyConflictError);
    respond(409, { name: "concurrent_idempotent_requests" });
    const concurrent = await new ResendTransport("key").send(message).catch((e: Error) => e);
    expect(concurrent).not.toBeInstanceOf(IdempotencyConflictError);
  });

  it("never puts the response message or the request (link, address) in the error", async () => {
    respond(422, { statusCode: 422, name: "validation_error", message: `Invalid to ${message.to} for ${message.text}` });
    const error = await new ResendTransport("key").send(message).catch((e: Error) => e);
    expect((error as Error).message).toBe("Resend responded 422 (validation_error)");
  });

  it("falls back to the status alone when the body isn't a known error shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    await expect(new ResendTransport("key").send(message)).rejects.toThrow(/^Resend responded 502$/);
    respond(500, { name: "Contains Spaces And Text <script>" });
    await expect(new ResendTransport("key").send(message)).rejects.toThrow(/^Resend responded 500$/);
  });
});
