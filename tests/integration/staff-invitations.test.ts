/**
 * Staff invitations against the LOCAL stack, with real Supabase Auth and the
 * real outbox worker: the invitation email rebuilds its link from the link id
 * on every attempt, the verification email gets a fresh Supabase link (an
 * invite for a new person, a magic link for an existing account), concurrent
 * acceptance creates one membership, a cancellation racing an acceptance has
 * exactly one outcome, and removing a member who created records keeps them
 * attributed while their open session loses access at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { sha256Hex, staffInviteToken } from "@/lib/proposals/tokens.server";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, draftAndSend, localStatus, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

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
let admin: Db;
let owner: Db;
let catalog: Catalog;
let other: Catalog;

async function invite(email: string) {
  const id = randomUUID();
  const linkId = randomUUID();
  const token = staffInviteToken(linkId);
  const { data } = await must(owner.rpc("create_staff_invitation", {
    p_tenant_id: catalog.tenantId, p_invitation_id: id, p_email: email, p_link_id: linkId, p_token_hash: sha256Hex(token),
  }));
  expect(data).toMatchObject({ status: "created" });
  return { id, linkId, token };
}

/** Delivers only this business's emails for one invitation (never other tenants' or platform emails). */
const deliver = (transport: EmailTransport, staffInvitationId: string) => processOutbox({ transport, tenantId: catalog.tenantId, staffInvitationId });

/** Makes a pending retry due (a minute back: the Docker clock can differ slightly). */
async function makeDue(invitationId: string) {
  await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 60_000).toISOString() }).eq("entity_id", invitationId).eq("status", "pending"));
}

const linkIn = (m: EmailMessage, pattern: RegExp) => pattern.exec(m.text)?.[1] ?? null;

/** Requests and delivers the verification email, then verifies it in a fresh browser-like client. */
async function verifyInvited(inv: { id: string; token: string }) {
  const { data: requested } = await must(admin.rpc("request_staff_sign_in", { p_token_hash: sha256Hex(inv.token) }));
  expect(requested).toMatchObject({ status: "ok" });
  const mail = new RecordingTransport();
  await deliver(mail, inv.id); // the verification email (and the invitation itself, if still queued)
  const message = mail.messages.find((m) => m.subject.startsWith("Confirm your email to join"))!;
  const confirm = new URL(linkIn(message, /(https?:\/\/\S+\/auth\/confirm\?\S+)/)!);
  expect(confirm.searchParams.get("next")).toBe(`/join/team/${inv.id}`);
  const type = confirm.searchParams.get("type") as "invite" | "email";
  const env = localStatus();
  const db = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(db.auth.verifyOtp({ token_hash: confirm.searchParams.get("token_hash")!, type }));
  return { db, type, message };
}

beforeAll(async () => {
  admin = adminClient();
  const me = await signedInUser(admin, `it-team-owner-${run}@example.test`);
  owner = me.db;
  catalog = await createTenantWithCatalog(admin, me.id, "it-team");
  const otherOwner = await signedInUser(admin, `it-team-other-${run}@example.test`);
  other = await createTenantWithCatalog(admin, otherOwner.id, "it-team-other");
});

afterAll(async () => {
  await archiveTestTenants(admin, catalog?.tenantId, other?.tenantId);
});

describe("staff invitations", () => {
  it("delivers the same link on every attempt, then a new person verifies and joins once, even with concurrent clicks", async () => {
    const email = `it-team-new-${run}@example.test`;
    const inv = await invite(email.toUpperCase());

    const flaky = new RecordingTransport(1);
    expect(await deliver(flaky, inv.id)).toMatchObject({ claimed: 1, failed: 1 });
    await makeDue(inv.id);
    expect(await deliver(flaky, inv.id)).toMatchObject({ claimed: 1, sent: 1 });
    const [first, second] = flaky.messages;
    expect(first.to).toBe(email);
    expect(first.fromName).toBe(`IT it-team via Flux DJ`);
    expect(first.subject).toBe("You've been invited to join IT it-team on Flux DJ");
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const link = linkIn(first, /(https?:\/\/\S+\/join\/team#\S+)/);
    expect(link).toBe(linkIn(second, /(https?:\/\/\S+\/join\/team#\S+)/));
    expect(new URL(link!).hash.slice(1)).toBe(inv.token);
    const { data: rows } = await must(admin.from("email_outbox").select("payload, last_error").eq("entity_id", inv.id));
    expect(JSON.stringify(rows)).not.toContain(inv.token);

    const { db: invitee, type } = await verifyInvited(inv);
    expect(type).toBe("invite"); // a new identity (public signup stays disabled)
    expect((await must(invitee.rpc("staff_invitation_status", { p_invitation_id: inv.id }))).data).toMatchObject({ state: "ready", email, display_name: "IT it-team" });

    const results = await Promise.all(Array.from({ length: 5 }, () => invitee.rpc("accept_staff_invitation", { p_invitation_id: inv.id })));
    const accepted = results.map((r) => r.data as { state: string; replayed: boolean });
    expect(accepted.every((r) => r.state === "accepted")).toBe(true);
    expect(accepted.filter((r) => !r.replayed)).toHaveLength(1);
    const { data: user } = await invitee.auth.getUser();
    const { data: members } = await must(admin.from("tenant_memberships").select("role").eq("tenant_id", catalog.tenantId).eq("user_id", user.user!.id));
    expect(members).toEqual([{ role: "staff" }]);
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(users.users.filter((u) => u.email === email)).toHaveLength(1);
  });

  it("an existing account (owner of another business) joins with a magic link and keeps its own business", async () => {
    const inv = await invite(`it-team-other-${run}@example.test`);
    const { db, type } = await verifyInvited(inv);
    expect(type).toBe("email"); // the existing identity is reused
    expect((await must(db.rpc("accept_staff_invitation", { p_invitation_id: inv.id }))).data).toMatchObject({ state: "accepted", outcome: "joined" });
    const { data: workspaces } = await must(db.rpc("my_workspaces"));
    expect(workspaces!.map((w) => [w.slug, w.role]).sort()).toEqual([[catalog.slug, "staff"], [other.slug, "owner"]].sort());
  });

  it("a cancellation racing an acceptance has exactly one outcome", async () => {
    const email = `it-team-race-${run}@example.test`;
    const inv = await invite(email);
    const { db } = await verifyInvited(inv);
    const [cancelled, accepted] = await Promise.all([
      owner.rpc("cancel_staff_invitation", { p_tenant_id: catalog.tenantId, p_invitation_id: inv.id }),
      db.rpc("accept_staff_invitation", { p_invitation_id: inv.id }),
    ]);
    const { data: row } = await must(admin.from("staff_invitations").select("accepted_at, revoked_at").eq("id", inv.id).single());
    const { data: user } = await db.auth.getUser();
    const { count } = await admin.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("tenant_id", catalog.tenantId).eq("user_id", user.user!.id);
    if (row!.accepted_at) {
      expect(cancelled.error?.message).toMatch(/invitation_not_cancellable/);
      expect(count).toBe(1);
    } else {
      expect(row!.revoked_at).not.toBeNull();
      expect(accepted.data).toMatchObject({ state: "invalid" });
      expect(count).toBe(0);
    }
  });

  it("removing a member who created a proposal keeps it attributed and ends their open session's access", async () => {
    const inv = await invite(`it-team-leaver-${run}@example.test`);
    const { db: leaver } = await verifyInvited(inv);
    await must(leaver.rpc("accept_staff_invitation", { p_invitation_id: inv.id }));
    const { eventId } = await createEvent(admin, catalog, `it-team-client-${run}@example.test`);
    const { proposalId } = await draftAndSend(leaver, catalog, eventId);
    const { data: user } = await leaver.auth.getUser();
    const { data: membership } = await must(admin.from("tenant_memberships").select("id").eq("tenant_id", catalog.tenantId).eq("user_id", user.user!.id).single());

    // A direct delete was never possible for such a member (immutable attribution); removal is soft.
    await must(owner.rpc("remove_staff_member", { p_tenant_id: catalog.tenantId, p_membership_id: membership!.id }));
    const { data: proposal } = await must(admin.from("proposals").select("created_by_membership_id").eq("id", proposalId).single());
    expect(proposal!.created_by_membership_id).toBe(membership!.id);

    // The same (still signed-in) session is refused on its next request.
    expect((await leaver.from("events").select("id").eq("tenant_id", catalog.tenantId)).data).toEqual([]);
    expect((await leaver.rpc("staff_dashboard", { p_tenant_id: catalog.tenantId, p_upcoming_limit: 8 })).error?.code).toBe("P0002");
    expect((await leaver.rpc("my_workspaces")).data).toEqual([]);
    const { data: users } = await admin.auth.admin.getUserById(user.user!.id);
    expect(users.user?.id).toBe(user.user!.id); // the account itself stays
  });
});
