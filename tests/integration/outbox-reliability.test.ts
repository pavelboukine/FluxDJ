/**
 * Outbox failure handling against the LOCAL Supabase stack: a failed claim is
 * reported (never treated as an empty queue) without stopping the other
 * categories; the dispatch check fails closed; an email the provider accepted
 * but the outbox couldn't record is not marked failed and is retried with the
 * same idempotency key. Database errors are injected around the real client,
 * for one named function at a time; everything else is the real database.
 * Every run is limited to this suite's own business (or to an invitation that
 * doesn't exist), so no other email is ever claimed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { errorSummary } from "@/lib/email/history";
import { OutboxRunError, POSSIBLY_DELIVERED, processOutbox } from "@/lib/email/outbox.server";
import { IdempotencyConflictError, type EmailMessage, type EmailTransport } from "@/lib/email/transport.server";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, draftAndSend, failingRpc as failing, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { id: `rec-${this.messages.length}` };
  }
}

let admin: Db;
let staff: Db;
let catalog: Catalog;

/** A proposal_sent email queued for a new event of this suite's business. */
async function queuedProposalEmail() {
  const { eventId } = await createEvent(admin, catalog, `it-rel-${randomUUID().slice(0, 8)}@example.test`);
  const { proposalId } = await draftAndSend(staff, catalog, eventId);
  const { data } = await must(admin.from("email_outbox").select("id").eq("entity_id", proposalId).eq("event_type", "proposal_sent").single());
  return { rowId: data!.id, proposalId };
}

async function row(id: string) {
  const { data } = await must(admin.from("email_outbox").select("status, attempts, last_error, locked_until, provider_message_id").eq("id", id).single());
  return data!;
}

const due = (id: string) => must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", id));

/** Runs the outbox and returns its OutboxRunError (failing the test if the run didn't throw one). */
async function failedRun(options: Parameters<typeof processOutbox>[0]): Promise<OutboxRunError> {
  const error = await processOutbox(options).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(OutboxRunError);
  return error as OutboxRunError;
}

describe("outbox reliability (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-rel-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-rel");
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId);
  });

  it("an empty queue is a normal, successful run", async () => {
    const transport = new RecordingTransport();
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toEqual({ claimed: 0, sent: 0, failed: 0, cancelled: 0, unconfirmed: 0 });
    expect(transport.messages).toHaveLength(0);
  });

  it.each([
    ["claim_staff_email_outbox", "Staff invitation"],
    ["claim_planning_email_outbox", "Planning invitation"],
  ])("a failed %s is reported, and the business's other emails still go out", async (fn, category) => {
    const { rowId } = await queuedProposalEmail();
    const transport = new RecordingTransport();
    const error = await failedRun({ transport, tenantId: catalog.tenantId, admin: failing(admin, fn) });
    expect(error.problems).toEqual([`${category} emails could not be claimed (XX000)`]);
    expect(error.result).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(await row(rowId)).toMatchObject({ status: "sent" });
    // Nothing about the email (address, link) is in what gets logged.
    expect(error.message).not.toMatch(/@|https?:/);
  });

  it("a failed DJ invitation claim is reported, not treated as an empty queue", async () => {
    // Limited to an invitation that doesn't exist, so no real invitation is claimed.
    const error = await failedRun({ transport: new RecordingTransport(), platformInvitationId: randomUUID(), admin: failing(admin, "claim_platform_email_outbox") });
    expect(error.problems).toEqual(["DJ invitation emails could not be claimed (XX000)"]);
    expect(error.result.claimed).toBe(0);
  });

  it("a failed business claim leaves its emails queued for the next run", async () => {
    const { rowId } = await queuedProposalEmail();
    const transport = new RecordingTransport();
    const error = await failedRun({ transport, tenantId: catalog.tenantId, admin: failing(admin, "claim_email_outbox", "57014") });
    expect(error.problems).toEqual(["Business emails could not be claimed (57014)"]);
    expect(transport.messages).toHaveLength(0);
    expect(await row(rowId)).toMatchObject({ status: "pending", attempts: 0 });

    // The next healthy run delivers it as usual.
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(rowId)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it.each(["PGRST202", "57014"])("the delivery check fails closed (%s): nothing is sent and the email is retried later", async (code) => {
    const { rowId } = await queuedProposalEmail();
    const transport = new RecordingTransport();
    const result = await processOutbox({ transport, tenantId: catalog.tenantId, admin: failing(admin, "email_outbox_dispatch_allowed", code) });
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1, cancelled: 0 });
    expect(transport.messages).toHaveLength(0);
    expect(await row(rowId)).toMatchObject({ status: "pending", attempts: 1, last_error: `The delivery check could not run (${code}); nothing was sent.` });

    await due(rowId);
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, sent: 1 });
    expect(transport.messages).toHaveLength(1);
  });

  it("a completion that fails once is retried and recorded", async () => {
    const { rowId } = await queuedProposalEmail();
    const transport = new RecordingTransport();
    expect(await processOutbox({ transport, tenantId: catalog.tenantId, admin: failing(admin, "complete_email_outbox", "XX000", 1) })).toMatchObject({
      claimed: 1,
      sent: 1,
      unconfirmed: 0,
    });
    expect(await row(rowId)).toMatchObject({ status: "sent", provider_message_id: "rec-1" });
  });

  it("an accepted email that can't be recorded is reported, never marked failed, and retried with the same key", async () => {
    const { rowId } = await queuedProposalEmail();
    const transport = new RecordingTransport();
    const error = await failedRun({ transport, tenantId: catalog.tenantId, admin: failing(admin, "complete_email_outbox") });
    expect(error.result).toMatchObject({ claimed: 1, sent: 0, failed: 0, unconfirmed: 1 });
    expect(error.problems).toEqual([`email ${rowId} was accepted by the provider but could not be recorded as sent (XX000)`]);
    // Not failed or rescheduled: it stays claimed until its lease ends.
    const stuck = await row(rowId);
    expect(stuck).toMatchObject({ status: "sending", attempts: 1, last_error: null });
    expect(Date.parse(stuck.locked_until!)).toBeGreaterThan(Date.now());
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 0 });

    // Once the lease ends it is claimed again; the repeat carries the same key, so the provider drops it.
    await must(admin.from("email_outbox").update({ locked_until: new Date(Date.now() - 60_000).toISOString() }).eq("id", rowId));
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(rowId)).toMatchObject({ status: "sent", attempts: 2 });
    expect(transport.messages).toHaveLength(2);
    expect(transport.messages[0].idempotencyKey).toBe(`flux-proposal-sent-${rowId}`);
    expect(transport.messages[1].idempotencyKey).toBe(transport.messages[0].idempotencyKey);
  });

  it("each proposal email has its own key", async () => {
    const [a, b] = [await queuedProposalEmail(), await queuedProposalEmail()];
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const keys = transport.messages.map((m) => m.idempotencyKey);
    expect(keys).toEqual(expect.arrayContaining([`flux-proposal-sent-${a.rowId}`, `flux-proposal-sent-${b.rowId}`]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a retry sends the identical request even after the business is renamed and its reply-to changed", async () => {
    const { rowId } = await queuedProposalEmail();
    const { data: before } = await must(admin.from("tenants").select("display_name, reply_to_email").eq("id", catalog.tenantId).single());
    const transport = new RecordingTransport();
    try {
      // Accepted, but not recorded: the row is claimed again later under the same key.
      await failedRun({ transport, tenantId: catalog.tenantId, admin: failing(admin, "complete_email_outbox") });
      await must(admin.from("tenants").update({ display_name: "Renamed Mid-Retry DJ", reply_to_email: "changed@example.test" }).eq("id", catalog.tenantId));
      await must(admin.from("email_outbox").update({ locked_until: new Date(Date.now() - 60_000).toISOString() }).eq("id", rowId));
      expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, sent: 1 });
    } finally {
      await must(admin.from("tenants").update(before!).eq("id", catalog.tenantId));
    }
    expect(transport.messages).toHaveLength(2);
    const [first, retry] = transport.messages;
    // Everything Resend sees: sender, recipient, reply-to, subject, both bodies (links included), attachments and the key.
    expect(retry).toEqual(first);
    expect(first.fromName).toBe(`${before!.display_name} via Flux DJ`);
    expect(first.text).not.toContain("Renamed Mid-Retry DJ");
    expect(first.idempotencyKey).toBe(`flux-proposal-sent-${rowId}`);
  });

  it("a provider refusal of a changed repeat is marked possibly delivered and not retried automatically", async () => {
    const { rowId } = await queuedProposalEmail();
    const refusing: EmailTransport = {
      name: "refusing",
      send: async () => {
        throw new IdempotencyConflictError("Resend responded 409 (invalid_idempotent_request)");
      },
    };
    expect(await processOutbox({ transport: refusing, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(await row(rowId)).toMatchObject({ status: "failed", attempts: 1, last_error: POSSIBLY_DELIVERED });
    // Staff see it as possibly delivered, not as a plain provider refusal.
    expect(errorSummary(POSSIBLY_DELIVERED)).toMatch(/^An earlier attempt may already have been delivered/);
    await due(rowId);
    expect(await processOutbox({ transport: new RecordingTransport(), tenantId: catalog.tenantId })).toMatchObject({ claimed: 0 });
  });

  it("a concurrent-request refusal is an ordinary, retried failure", async () => {
    const { rowId } = await queuedProposalEmail();
    const busy: EmailTransport = {
      name: "busy",
      send: async () => {
        throw new Error("Resend responded 409 (concurrent_idempotent_requests)");
      },
    };
    expect(await processOutbox({ transport: busy, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, failed: 1 });
    expect(await row(rowId)).toMatchObject({ status: "pending", attempts: 1, last_error: "Resend responded 409 (concurrent_idempotent_requests)" });
  });
});
