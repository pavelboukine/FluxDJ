/**
 * DJ invitations against the LOCAL stack, with real Supabase Auth and the
 * real outbox worker: the invitation email rebuilds its link from the link id
 * on every attempt, the verification email gets a fresh Supabase link at
 * delivery, and concurrent workspace submissions create exactly one business.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { platformInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { adminClient, archiveTestTenants, localStatus, must, signedInUser, type Db } from "./support/fixtures";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

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

const run = randomUUID().slice(0, 8);
const operatorEmail = `it-operator-${run}@example.test`;
let admin: Db;
let operator: Db;
const createdTenants: string[] = [];
const invitations: string[] = [];

function newLink() {
  const linkId = randomUUID();
  return { linkId, token: platformInviteToken(linkId) };
}

async function invite(email: string) {
  const { linkId, token } = newLink();
  const { data } = await must(operator.rpc("create_platform_invitation", { p_email: email, p_link_id: linkId, p_token_hash: sha256Hex(token) }));
  const result = data as { invitation_id: string; status: string };
  invitations.push(result.invitation_id);
  return { id: result.invitation_id, linkId, token, status: result.status };
}

/** Makes queued emails of an invitation due now (retries back off otherwise). */
/**
 * Makes a pending retry due. A minute in the past, not "now": the test's clock
 * and the database's (Docker VM) clock can differ by tens of milliseconds, and
 * an immediate claim would then still see the retry as in the future.
 */
async function makeDue(invitationId: string) {
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await must(admin.from("email_outbox").update({ next_attempt_at: dueAt }).eq("entity_id", invitationId).eq("status", "pending"));
}

const linkIn = (m: EmailMessage, pattern: RegExp) => pattern.exec(m.text)?.[1] ?? null;

beforeAll(async () => {
  admin = adminClient();
  operator = (await signedInUser(admin, operatorEmail)).db;
  grantPlatformAdminLocally(operatorEmail);
});

afterAll(async () => {
  // Unaccepted invitations are revoked (accepted ones refuse, which is fine).
  for (const id of invitations) await operator.rpc("revoke_platform_invitation", { p_invitation_id: id });
  revokePlatformAdminLocally(operatorEmail);
  await archiveTestTenants(admin, ...createdTenants);
});

describe("DJ invitations", () => {
  it("delivers the invitation with the same link on every attempt, then a fresh verification link", async () => {
    const email = `it-dj-${run}@example.test`;
    const inv = await invite(email.toUpperCase());

    const flaky = new RecordingTransport(1);
    expect(await processOutbox({ transport: flaky, platformInvitationId: inv.id })).toMatchObject({ claimed: 1, failed: 1 });
    await makeDue(inv.id);
    expect(await processOutbox({ transport: flaky, platformInvitationId: inv.id })).toMatchObject({ claimed: 1, sent: 1 });
    expect(flaky.messages).toHaveLength(2);
    const [first, second] = flaky.messages;
    expect(first.to).toBe(email);
    expect(second.to).toBe(email);
    expect(first.fromName).toBe("Flux DJ");
    expect(first.replyTo).toBeNull();
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const link = linkIn(first, /(https?:\/\/\S+\/join#\S+)/);
    expect(link).toBe(linkIn(second, /(https?:\/\/\S+\/join#\S+)/));
    expect(new URL(link!).hash.slice(1)).toBe(inv.token);
    const { data: row } = await must(admin.from("email_outbox").select("payload, last_error, status").eq("entity_id", inv.id).single());
    expect(JSON.stringify(row)).not.toContain(inv.token);

    // The DJ asks for verification with the token from the link.
    const { data: requested } = await must(admin.rpc("request_platform_sign_in", { p_token_hash: sha256Hex(inv.token) }));
    expect(requested).toMatchObject({ status: "ok" });
    const mail = new RecordingTransport();
    expect(await processOutbox({ transport: mail, platformInvitationId: inv.id })).toMatchObject({ sent: 1 });
    const confirm = new URL(linkIn(mail.messages[0], /(https?:\/\/\S+\/auth\/confirm\?\S+)/)!);
    expect(mail.messages[0].to).toBe(email);
    expect(confirm.searchParams.get("type")).toBe("invite");
    expect(confirm.searchParams.get("next")).toBe(`/join/${inv.id}`);
    const { data: stored } = await must(admin.from("email_outbox").select("payload").eq("entity_id", inv.id).eq("event_type", "platform_sign_in").single());
    expect(JSON.stringify(stored)).not.toContain(confirm.searchParams.get("token_hash")!);

    // Verifying creates the identity (public signup stays disabled); then
    // concurrent submissions create exactly one business.
    const env = localStatus();
    const dj = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await must(dj.auth.verifyOtp({ token_hash: confirm.searchParams.get("token_hash")!, type: "invite" }));
    expect((await must(dj.rpc("platform_invitation_status", { p_invitation_id: inv.id }))).data).toMatchObject({ state: "ready", email });
    const slugs = Array.from({ length: 5 }, (_, i) => `it-dj-${run}-${i}`);
    const results = await Promise.all(
      slugs.map((slug) => dj.rpc("accept_platform_invitation", { p_invitation_id: inv.id, p_display_name: `IT DJ ${run}`, p_slug: slug })),
    );
    const created = results.map((r) => r.data as { state: string; slug: string; replayed: boolean });
    expect(created.every((r) => r.state === "created")).toBe(true);
    expect(new Set(created.map((r) => r.slug)).size).toBe(1);
    expect(created.filter((r) => !r.replayed)).toHaveLength(1);
    const { data: tenants } = await must(admin.from("tenants").select("id, slug").in("slug", slugs));
    expect(tenants).toHaveLength(1);
    createdTenants.push(tenants![0].id);
    const { data: members } = await must(admin.from("tenant_memberships").select("role, user_id").eq("tenant_id", tenants![0].id));
    const { data: me } = await dj.auth.getUser();
    expect(members).toEqual([{ role: "owner", user_id: me.user!.id }]);
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(users.users.filter((u) => u.email === email)).toHaveLength(1);
  });

  it("a resend cancels the queued email for the previous link and only the new link is delivered", async () => {
    const inv = await invite(`it-resend-${run}@example.test`);
    await must(admin.from("platform_invitations").update({ last_sent_at: new Date(Date.now() - 5 * 60_000).toISOString() }).eq("id", inv.id));
    const next = newLink();
    await must(operator.rpc("resend_platform_invitation", { p_invitation_id: inv.id, p_link_id: next.linkId, p_token_hash: sha256Hex(next.token) }));
    const mail = new RecordingTransport();
    expect(await processOutbox({ transport: mail, platformInvitationId: inv.id })).toMatchObject({ claimed: 1, sent: 1 });
    expect(new URL(linkIn(mail.messages[0], /(https?:\/\/\S+\/join#\S+)/)!).hash.slice(1)).toBe(next.token);
    const { data: rows } = await must(admin.from("email_outbox").select("status, payload").eq("entity_id", inv.id).order("created_at"));
    expect(rows!.map((r) => [r.status, (r.payload as { link_id: string }).link_id])).toEqual([
      ["cancelled", inv.linkId],
      ["sent", next.linkId],
    ]);
    const { data: old } = await must(admin.rpc("request_platform_sign_in", { p_token_hash: sha256Hex(inv.token) }));
    expect(old).toMatchObject({ status: "invalid" });
  });

  it("rechecks at delivery: an invitation that expired or was revoked meanwhile is not sent", async () => {
    const expired = await invite(`it-expired-${run}@example.test`);
    await must(admin.from("platform_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", expired.id));
    const mail = new RecordingTransport();
    expect(await processOutbox({ transport: mail, platformInvitationId: expired.id })).toMatchObject({ claimed: 1, cancelled: 1 });

    const revoked = await invite(`it-revoked-${run}@example.test`);
    const { data: requested } = await must(admin.rpc("request_platform_sign_in", { p_token_hash: sha256Hex(revoked.token) }));
    expect(requested).toMatchObject({ status: "ok" });
    await must(operator.rpc("revoke_platform_invitation", { p_invitation_id: revoked.id }));
    expect(await processOutbox({ transport: mail, platformInvitationId: revoked.id })).toMatchObject({ claimed: 0 });
    expect(mail.messages).toHaveLength(0);
    const { data: rows } = await must(admin.from("email_outbox").select("status").eq("entity_id", revoked.id));
    expect(rows!.every((r) => r.status === "cancelled")).toBe(true);
  });
});
