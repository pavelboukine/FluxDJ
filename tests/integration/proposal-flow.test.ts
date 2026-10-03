/**
 * Step 6 flow against the LOCAL Supabase stack: the email outbox (failure,
 * retry, deduplication, link re-derivation, cancellation, Mailpit delivery),
 * link and session security, and concurrent submissions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processOutbox } from "@/lib/email/outbox.server";
import { MailpitTransport, type EmailMessage, type EmailTransport } from "@/lib/email/transport.server";
import { sha256Hex } from "@/lib/proposals/tokens.server";
import {
  adminClient,
  bothSeparate,
  clientView,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  must,
  openLink,
  sendDraft,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

const MAILPIT = "http://127.0.0.1:54324";

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  constructor(private failuresLeft = 0) {}
  async send(message: EmailMessage) {
    this.messages.push(message);
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("Simulated provider outage (503)");
    }
    return { id: `rec-${this.messages.length}` };
  }
}

const linkIn = (message: EmailMessage) => /https?:\/\/\S+\/p#([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];

let admin: Db;
let staff: Db;
let catalog: Catalog;

async function rowsFor(proposalId: string) {
  const { data } = await must(admin.from("email_outbox").select("id, event_type, status, attempts, last_error, next_attempt_at").eq("entity_id", proposalId).order("created_at"));
  return data!;
}

async function businessCounts(proposalId: string, eventId: string) {
  const [proposals, links, selections, approvals] = await Promise.all([
    admin.from("proposals").select("id", { count: "exact", head: true }).eq("event_id", eventId),
    admin.from("access_links").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId),
    admin.from("proposal_selections").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId),
    admin.from("proposal_approvals").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId),
  ]);
  return { proposals: proposals.count, links: links.count, selections: selections.count, approvals: approvals.count };
}

describe("proposal flow and email outbox (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-flow-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-flow");
  });

  afterAll(async () => {
    if (admin && catalog) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", catalog.tenantId);
  });

  it("retries a failed proposal email with the same link and no duplicate business records", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-retry-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const before = await businessCounts(proposalId, eventId);

    const transport = new RecordingTransport(1);
    const first = await processOutbox({ transport, tenantId: catalog.tenantId });
    expect(first).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    const [afterFailure] = await rowsFor(proposalId);
    expect(afterFailure).toMatchObject({ status: "pending", attempts: 1, last_error: "Simulated provider outage (503)" });
    expect(Date.parse(afterFailure.next_attempt_at)).toBeGreaterThan(Date.now());

    // Backoff: not retried immediately.
    expect((await processOutbox({ transport, tenantId: catalog.tenantId })).claimed).toBe(0);
    await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", afterFailure.id));

    const second = await processOutbox({ transport, tenantId: catalog.tenantId });
    expect(second).toMatchObject({ claimed: 1, sent: 1 });
    const [delivered] = await rowsFor(proposalId);
    expect(delivered).toMatchObject({ status: "sent", attempts: 2 });

    // Both attempts carried the identical link, re-derived from the link id; it matches the stored hash.
    expect(transport.messages).toHaveLength(2);
    const [firstLink, secondLink] = transport.messages.map(linkIn);
    expect(firstLink).toBe(token);
    expect(secondLink).toBe(token);
    const { data: link } = await must(admin.from("access_links").select("token_hash").eq("proposal_id", proposalId).single());
    expect(sha256Hex(secondLink!)).toBe(link!.token_hash);
    // The outbox row itself holds no token.
    const { data: stored } = await must(admin.from("email_outbox").select("payload").eq("id", afterFailure.id).single());
    expect(JSON.stringify(stored)).not.toContain(token);

    // Processing again sends nothing more; retries created no business records.
    expect((await processOutbox({ transport, tenantId: catalog.tenantId })).claimed).toBe(0);
    expect(await businessCounts(proposalId, eventId)).toEqual(before);
  });

  it("marks an email failed after the last attempt, then lets staff retry it", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-dead-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId } = await draftAndSend(staff, catalog, eventId);
    const [row] = await rowsFor(proposalId);
    await must(admin.from("email_outbox").update({ max_attempts: 1 }).eq("id", row.id));
    await processOutbox({ transport: new RecordingTransport(5), tenantId: catalog.tenantId });
    expect((await rowsFor(proposalId))[0]).toMatchObject({ status: "failed", attempts: 1 });

    const { data: retried } = await must(staff.rpc("retry_email_outbox", { p_id: row.id }));
    expect(retried).toBe(true);
    const ok = new RecordingTransport();
    expect((await processOutbox({ transport: ok, tenantId: catalog.tenantId })).sent).toBe(1);
    expect((await rowsFor(proposalId))[0].status).toBe("sent");
  });

  it("cancels an undelivered proposal email when a revision supersedes it, and sends only the new link", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-supersede-${randomUUID().slice(0, 6)}@example.test`);
    const first = await draftAndSend(staff, catalog, eventId);
    const { data: revisionId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    const second = await sendDraft(staff, revisionId as string);

    expect((await rowsFor(first.proposalId))[0].status).toBe("cancelled");
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    expect(transport.messages.map(linkIn)).toEqual([second.token]);
    expect((await openLink(admin, catalog.slug, first.token)).status).toBe("superseded");
    expect((await openLink(admin, catalog.slug, second.token)).status).toBe("ok");
  });

  it("refuses to send a link that no longer matches the server secret (rotated secret)", async () => {
    const clientEmail = `it-rotate-${randomUUID().slice(0, 6)}@example.test`;
    const { eventId } = await createEvent(admin, catalog, clientEmail);
    const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
    const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input! }));
    await must(
      staff.rpc("send_proposal", {
        p_proposal_id: proposalId as string,
        p_expected_draft_version: 0,
        p_access_link_id: randomUUID(),
        p_token_hash: sha256Hex(`a token from an old secret ${randomUUID()}`),
      }),
    );
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    expect(transport.messages.filter((m) => m.to === clientEmail)).toHaveLength(0);
    const [row] = await rowsFor(proposalId as string);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/link secret changed/);
  });

  it("delivers the whole flow's emails to Mailpit: proposal, link opened, submitted, approved", async () => {
    const clientEmail = `it-mailpit-${randomUUID().slice(0, 6)}@example.test`;
    const { eventId } = await createEvent(admin, catalog, clientEmail);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
    expect(submitted.status).toBe("submitted");
    const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).single());
    await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));

    await processOutbox({ transport: new MailpitTransport(MAILPIT), tenantId: catalog.tenantId });
    const types = (await rowsFor(proposalId)).map((r) => [r.event_type, r.status]);
    expect(types).toEqual([
      ["proposal_sent", "sent"],
      ["proposal_link_opened", "sent"],
      ["proposal_submitted", "sent"],
      ["proposal_approved", "sent"],
    ]);

    const search = async (query: string) =>
      ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}`)).json()) as { messages: { Subject: string }[] }).messages;
    const toClient = await search(`to:"${clientEmail}"`);
    expect(toClient.map((m) => m.Subject).sort()).toEqual([
      `${"IT it-flow"} approved your selection for IT wedding`,
      `${"IT it-flow"} sent you a proposal for IT wedding`,
    ]);
    const toStaff = (await search(`to:"${catalog.slug}@example.test"`)).map((m) => m.Subject);
    expect(toStaff).toContain("Proposal link opened: IT wedding");
    expect(toStaff).toContain("Submitted for your review: IT wedding");
  });

  it("serializes concurrent submissions: exactly one wins, same-key retries replay it", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-race-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const a = await openLink(admin, catalog.slug, token);
    const b = await openLink(admin, catalog.slug, token);
    const input = { package_key: "signature", answers: bothSeparate };
    const sameKey = randomUUID().replaceAll("-", "");

    const results = await Promise.all([
      submit(admin, { slug: catalog.slug, proposalId, sessionHash: a.sessionHash, draftVersion: 0, key: sameKey, input }),
      submit(admin, { slug: catalog.slug, proposalId, sessionHash: a.sessionHash, draftVersion: 0, key: sameKey, input }),
      submit(admin, { slug: catalog.slug, proposalId, sessionHash: b.sessionHash, draftVersion: 0, input }),
      submit(admin, { slug: catalog.slug, proposalId, sessionHash: b.sessionHash, draftVersion: 0, input }),
    ]);
    const created = results.filter((r) => r.status === "submitted" && r.replayed === false);
    expect(created).toHaveLength(1);
    const { count } = await admin.from("proposal_selections").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId);
    expect(count).toBe(1);
    // The two same-key calls return the same selection whichever ran first.
    if (results[0].status === "submitted" && results[1].status === "submitted") expect(results[0].selection_id).toBe(results[1].selection_id);
  });

  it("never exposes internal fields and grants no event access through a proposal link", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-leak-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { count: accessBefore } = await admin.from("event_access").select("id", { count: "exact", head: true });
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const view = await clientView(admin, catalog.slug, proposalId, sessionHash);
    expect(view.state).toBe("open");
    expect(JSON.stringify(view)).not.toContain("IT staff-only secret");
    expect(JSON.stringify(view)).not.toContain("draft_offer");
    const { count: accessAfter } = await admin.from("event_access").select("id", { count: "exact", head: true });
    expect(accessAfter).toBe(accessBefore);
    // A session for this tenant is useless under another tenant's slug.
    expect((await clientView(admin, "bouprod", proposalId, sessionHash)).state).toBe("invalid");
  });
});
