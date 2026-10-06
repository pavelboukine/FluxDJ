/**
 * Contract sending and verified client onboarding against the LOCAL stack,
 * with real Supabase Auth: the outbox worker creates verification links at
 * delivery time, the client verifies with the token from the email, and only
 * then can accept the invitation and read the contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import {
  adminClient,
  archiveTestTenants,
  bothSeparate,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  localStatus,
  must,
  openLink,
  sendDraft,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

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

const SECTIONS = [{ heading: "Parties", body: "{{business.legal_name}} and {{client.name}}. Total {{pricing.total}}, deposit {{payment.deposit}}." }];
const verification = (m: EmailMessage) => {
  const href = /(https?:\/\/\S+\/auth\/confirm\?\S+)/.exec(m.text)?.[1];
  if (!href) return null;
  const url = new URL(href);
  return { tokenHash: url.searchParams.get("token_hash")!, type: url.searchParams.get("type")!, next: url.searchParams.get("next")! };
};

let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;
let otherOwner: { id: string; db: Db; email: string };

async function anonDb(): Promise<Db> {
  const env = localStatus();
  return createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A sent contract for a new event whose signer has `clientEmail`. */
async function sentContract(clientEmail: string) {
  const { eventId, clientId } = await createEvent(admin, catalog, clientEmail);
  const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  return { eventId, clientId, contractId, linkId, inviteToken: contractInviteToken(linkId) };
}

let otherTenantId: string | undefined;

describe("contract sending and verified client access (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-send-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-send");
    const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT agreement", p_title: "DEMO, NOT FOR CLIENT USE: IT", p_sections: SECTIONS }));
    const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    versionId = version!.id;
    await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
    const email = `it-send-other-${randomUUID().slice(0, 8)}@example.test`;
    const other = await signedInUser(admin, email);
    otherTenantId = (await createTenantWithCatalog(admin, other.id, "it-send-b")).tenantId;
    otherOwner = { ...other, email };
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherTenantId);
  });

  it("onboards a new client: invite identity created at delivery, verified, then explicit acceptance", async () => {
    const clientEmail = `it-new-client-${randomUUID().slice(0, 8)}@example.test`;
    const { eventId, contractId, linkId, inviteToken } = await sentContract(clientEmail);

    // 1. Contract email: the invitation link carries the derived token in the fragment.
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const contractEmail = transport.messages.find((m) => m.to === clientEmail && /sent your contract/.test(m.subject))!;
    expect(contractEmail.subject).toMatch(/sent your contract/);
    expect(contractEmail.text).toContain(`/${catalog.slug}/invite#${inviteToken}`);
    expect(JSON.stringify((await must(admin.from("email_outbox").select("payload").eq("entity_id", contractId))).data)).not.toContain(inviteToken);

    // 2. No identity exists yet, and public signup is disabled.
    const { data: before } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(before.users.some((u) => u.email === clientEmail)).toBe(false);
    const signup = await (await anonDb()).auth.signInWithOtp({ email: clientEmail, options: { shouldCreateUser: true } });
    expect(signup.error?.message).toMatch(/Signups not allowed/i);

    // 3. The client asks for a verification email (what the invite page's action does).
    const { data: requested } = await must(admin.rpc("request_contract_sign_in", { p_token_hash: sha256Hex(inviteToken), p_tenant_slug: catalog.slug }));
    expect(requested).toMatchObject({ status: "ok" });
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const link = verification(transport.messages.at(-1)!)!;
    expect(link).toMatchObject({ type: "invite", next: `/${catalog.slug}/invitations/${linkId}` });
    const { data: after } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const invited = after.users.find((u) => u.email === clientEmail)!;
    expect(invited.email_confirmed_at ?? null).toBeNull();
    // Receiving or opening links grants nothing; no token is stored anywhere in the outbox.
    expect((await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId)).count).toBe(0);
    expect(JSON.stringify((await must(admin.from("email_outbox").select("payload, last_error").eq("entity_id", contractId))).data)).not.toContain(link.tokenHash);

    // 4. Verification through Supabase Auth (what the confirm page's POST does), then explicit acceptance.
    const client = await anonDb();
    await must(client.auth.verifyOtp({ token_hash: link.tokenHash, type: "invite" }));
    expect((await must(client.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toEqual({ state: "unavailable" });
    expect((await must(client.rpc("client_invitation_status", { p_link_id: linkId, p_tenant_slug: catalog.slug }))).data).toMatchObject({ state: "ready" });
    expect((await must(client.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }))).data).toEqual({ state: "accepted", contract_id: contractId });
    const view = (await must(client.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data as { state: string; contract: { rendered_content: unknown } };
    expect(view.state).toBe("available");
    expect(JSON.stringify(view)).not.toMatch(/IT staff-only secret|internal_notes|token_hash/);

    // 5. The new identity is a client only: no staff membership anywhere, one event grant.
    expect((await admin.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", invited.id)).count).toBe(0);
    expect((await admin.from("event_access").select("event_id").eq("user_id", invited.id)).data).toEqual([{ event_id: eventId }]);
    // The same verified token cannot be reused.
    expect((await (await anonDb()).auth.verifyOtp({ token_hash: link.tokenHash, type: "invite" })).error).toBeTruthy();
  });

  it("reuses an existing identity with a staff role elsewhere, without inferring any permission from the email", async () => {
    const { contractId, linkId, inviteToken } = await sentContract(otherOwner.email);
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    await must(admin.rpc("request_contract_sign_in", { p_token_hash: sha256Hex(inviteToken), p_tenant_slug: catalog.slug }));
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const link = verification(transport.messages.at(-1)!)!;
    expect(link.type).toBe("email"); // existing verified identity: magic link, not a new invite

    // Already signed in as that verified identity: still nothing until explicit acceptance.
    expect((await must(otherOwner.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toEqual({ state: "unavailable" });
    expect((await must(otherOwner.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }))).data).toMatchObject({ state: "accepted" });
    expect((await must(otherOwner.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toMatchObject({ state: "available" });
    // A client grant here gives no staff access to this tenant.
    expect((await must(otherOwner.db.from("events").select("id").eq("tenant_id", catalog.tenantId))).data).toEqual([]);
    expect((await admin.from("tenant_memberships").select("tenant_id").eq("user_id", otherOwner.id)).data).toHaveLength(1);

    // A different verified user (the staff owner here) cannot accept or read it.
    expect((await must(staff.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }))).data).toMatchObject({ state: "wrong_account" });
    expect((await must(staff.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toEqual({ state: "unavailable" });
  });

  it("retries a failed verification email with a fresh link that supersedes the undelivered one", async () => {
    const clientEmail = `it-retry-client-${randomUUID().slice(0, 8)}@example.test`;
    const { contractId, inviteToken } = await sentContract(clientEmail);
    await processOutbox({ transport: new RecordingTransport(), tenantId: catalog.tenantId });
    await must(admin.rpc("request_contract_sign_in", { p_token_hash: sha256Hex(inviteToken), p_tenant_slug: catalog.slug }));

    const transport = new RecordingTransport(1);
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ claimed: 1, failed: 1 });
    const { data: row } = await must(admin.from("email_outbox").select("id, status, last_error").eq("entity_id", contractId).eq("event_type", "contract_sign_in").single());
    expect(row).toMatchObject({ status: "pending", last_error: "Simulated provider outage (503)" });
    await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", row!.id));
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ sent: 1 });

    const [failed, delivered] = transport.messages.map((m) => verification(m)!);
    expect(failed.tokenHash).not.toBe(delivered.tokenHash);
    expect((await (await anonDb()).auth.verifyOtp({ token_hash: failed.tokenHash, type: failed.type as "invite" })).error).toBeTruthy();
    expect((await (await anonDb()).auth.verifyOtp({ token_hash: delivered.tokenHash, type: delivered.type as "invite" })).error).toBeNull();
  });

  it("cancels queued contract emails that became obsolete before dispatch", async () => {
    const { contractId, linkId, inviteToken } = await sentContract(`it-obsolete-${randomUUID().slice(0, 8)}@example.test`);
    await processOutbox({ transport: new RecordingTransport(), tenantId: catalog.tenantId });
    await must(admin.rpc("request_contract_sign_in", { p_token_hash: sha256Hex(inviteToken), p_tenant_slug: catalog.slug }));
    // The invitation is revoked after queueing (e.g. a resend racing the worker).
    await must(admin.from("access_links").update({ revoked_at: new Date().toISOString() }).eq("id", linkId));
    const transport = new RecordingTransport();
    expect(await processOutbox({ transport, tenantId: catalog.tenantId })).toMatchObject({ cancelled: 1, sent: 0 });
    expect(transport.messages).toHaveLength(0);
    const { data } = await must(admin.from("email_outbox").select("status").eq("entity_id", contractId).eq("event_type", "contract_sign_in"));
    expect(data).toEqual([{ status: "cancelled" }]);
  });

  it("returns the same result for concurrent sends", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-concurrent-${randomUUID().slice(0, 8)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
    const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const send = () => {
      const id = randomUUID();
      return staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: id, p_token_hash: sha256Hex(contractInviteToken(id)) });
    };
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect((await admin.from("access_links").select("id", { count: "exact", head: true }).eq("contract_id", contractId)).count).toBe(1);
    expect((await admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("entity_id", contractId)).count).toBe(1);
  });

  it("voids once under concurrent requests, notifies once without the reason, and cuts off an existing client session", async () => {
    const clientEmail = `it-void-client-${randomUUID().slice(0, 8)}@example.test`;
    const { contractId, linkId, inviteToken } = await sentContract(clientEmail);
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    await must(admin.rpc("request_contract_sign_in", { p_token_hash: sha256Hex(inviteToken), p_tenant_slug: catalog.slug }));
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const link = verification(transport.messages.at(-1)!)!;
    const client = await anonDb();
    await must(client.auth.verifyOtp({ token_hash: link.tokenHash, type: "invite" }));
    await must(client.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
    expect((await must(client.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toMatchObject({ state: "available" });

    const reason = `Internal reason ${randomUUID().slice(0, 6)}`;
    const results = await Promise.all([1, 2, 3].map(() => staff.rpc("void_contract", { p_contract_id: contractId, p_reason: reason })));
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect((await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("entity_id", contractId).eq("action", "voided")).count).toBe(1);

    // The client is already signed in, and still loses access immediately.
    expect((await must(client.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data).toEqual({ state: "unavailable" });
    expect((await must(client.rpc("my_contracts"))).data).toEqual([]);

    const delivery = new RecordingTransport();
    await processOutbox({ transport: delivery, tenantId: catalog.tenantId });
    const notices = delivery.messages.filter((m) => m.to === clientEmail && /no longer available/.test(m.subject));
    expect(notices).toHaveLength(1);
    expect(notices[0].subject).toMatch(/is no longer available$/);
    expect(notices[0].text).not.toContain(reason);
    expect(notices[0].text).not.toMatch(/https?:\/\//);
    // Repeating the worker sends nothing more.
    await processOutbox({ transport: delivery, tenantId: catalog.tenantId });
    expect(delivery.messages.filter((m) => m.to === clientEmail && /no longer available/.test(m.subject))).toHaveLength(1);
  });

  it("notifies the signer when a revised offer voids the contract, but never because an event is archived", async () => {
    const revisedEmail = `it-revised-${randomUUID().slice(0, 8)}@example.test`;
    const archivedEmail = `it-archived-${randomUUID().slice(0, 8)}@example.test`;
    const revised = await sentContract(revisedEmail);
    const archived = await sentContract(archivedEmail);
    await processOutbox({ transport: new RecordingTransport(), tenantId: catalog.tenantId });

    const { data: draftId } = await must(staff.rpc("open_proposal_draft", { p_event_id: revised.eventId }));
    await sendDraft(staff, draftId as string);
    await must(staff.rpc("set_event_archived", { p_event_id: archived.eventId, p_archived: true }));

    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId });
    const notices = transport.messages.filter((m) => /no longer available/.test(m.subject));
    expect(notices.map((m) => m.to)).toEqual([revisedEmail]);
    expect(notices[0].text).not.toMatch(/revised offer|https?:\/\//);
    expect((await must(admin.from("contracts").select("status").eq("id", archived.contractId).single())).data).toEqual({ status: "sent" });
  });
});
