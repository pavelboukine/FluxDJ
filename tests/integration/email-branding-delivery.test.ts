/**
 * Branded emails and delivery feedback against the LOCAL stack, with real
 * logos in private Storage and the real outbox worker (recording transport):
 * each business's own logo arrives as an inline image, a business without a
 * logo (or whose logo can't be read) still gets its email, a retry renders
 * the branding frozen at the first attempt, and Resend webhooks (through the
 * real route handler) update only the matching email, idempotently.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEBHOOK_SECRET = `whsec_${Buffer.from(`it-webhook-${randomUUID()}`).toString("base64")}`;
process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET; // before the first serverEnv() read

import { POST as webhook } from "@/app/api/webhooks/resend/route";
import { LOGO_BUCKET, processLogo, storeLogo } from "@/lib/branding/logo.server";
import { fitLogo } from "@/lib/email/branding.server";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, draftAndSend, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

const run = randomUUID().slice(0, 8);

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
    return { id: `re_${run}_${randomUUID().slice(0, 8)}` };
  }
}

let admin: Db;
const owners: Record<string, { id: string; db: Db }> = {};
const shops: Record<string, Catalog> = {};
/** Business A's first proposal email (provider message id), for the webhook isolation check. */
let messageA = "";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const square = (color: string, width = 600, height = 200) =>
  sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();

/** Uploads and activates a logo the way Settings → Branding does. Returns the stored path. */
async function activateLogo(key: string, color: string, version: number): Promise<string> {
  const processed = await processLogo(await square(color));
  if (!processed.ok) throw new Error(processed.message);
  const stored = await storeLogo(shops[key].tenantId, owners[key].id, processed.logo);
  if (!stored.ok) throw new Error("logo not stored");
  await must(owners[key].db.rpc("update_tenant_branding", { p_tenant_id: shops[key].tenantId, p_expected_version: version, p_logo_id: stored.stored.logoId, p_primary_color: color }));
  return stored.stored.path;
}

async function sendProposal(key: string): Promise<string> {
  const { eventId } = await createEvent(admin, shops[key], `it-mail-${key}-${randomUUID().slice(0, 6)}@example.test`);
  const { proposalId } = await draftAndSend(owners[key].db, shops[key], eventId);
  return proposalId;
}

const deliver = (transport: EmailTransport, key: string) => processOutbox({ transport, tenantId: shops[key].tenantId });
const inlineLogo = (m: EmailMessage) => m.attachments?.find((a) => a.contentId === "business-logo");
async function expectedLogo(path: string) {
  const { data } = await admin.storage.from(LOGO_BUCKET).download(path);
  return (await fitLogo(Buffer.from(await data!.arrayBuffer())))!.png;
}

function signedRequest(event: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("http://localhost/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` } });
}
const outboxRow = async (messageId: string) =>
  (await must(admin.from("email_outbox").select("status, provider_status, provider_detail, attempts, next_attempt_at").eq("provider_message_id", messageId).single())).data!;

beforeAll(async () => {
  admin = adminClient();
  for (const key of ["a", "b", "plain"]) {
    owners[key] = await signedInUser(admin, `it-mail-${key}-${run}@example.test`);
    shops[key] = await createTenantWithCatalog(admin, owners[key].id, `it-mail-${key}`);
  }
});

afterAll(async () => {
  await archiveTestTenants(admin, ...Object.values(shops).map((s) => s.tenantId));
});

describe("branded emails", () => {
  let pathA = "";

  it("each business's proposal email carries its own logo inline; no logo means its name instead", async () => {
    pathA = await activateLogo("a", "#be123c", 0);
    const pathB = await activateLogo("b", "#1d4ed8", 0);
    await sendProposal("a");
    await sendProposal("b");
    await sendProposal("plain");

    const mail = new RecordingTransport();
    await deliver(mail, "a");
    await deliver(mail, "b");
    await deliver(mail, "plain");
    const [toA, toB, toPlain] = mail.messages;
    expect(toA.fromName).toBe("IT it-mail-a via Flux DJ");
    expect(toA.html).toContain('src="cid:business-logo"');
    expect(toA.html).toContain("background:#be123c");
    expect(sha(inlineLogo(toA)!.content)).toBe(sha(await expectedLogo(pathA)));
    expect(sha(inlineLogo(toB)!.content)).toBe(sha(await expectedLogo(pathB)));
    expect(sha(inlineLogo(toA)!.content)).not.toBe(sha(inlineLogo(toB)!.content)); // never another business's logo
    expect(inlineLogo(toA)!.content.length).toBeLessThan(120 * 1024);
    expect(toPlain.attachments).toBeUndefined();
    expect(toPlain.html).not.toContain("cid:");
    expect(toPlain.text.split("\n")[0]).toBe("IT it-mail-plain");
    for (const m of mail.messages) expect(m.text).toMatch(/Review your proposal: http\S+\/p#\S{43}/);
    messageA = (await must(admin.from("email_outbox").select("provider_message_id").eq("tenant_id", shops.a.tenantId).eq("event_type", "proposal_sent").single())).data!.provider_message_id!;
  });

  it("a retry renders the branding frozen at the first attempt, even after the logo changes", async () => {
    const proposalId = await sendProposal("a");
    const flaky = new RecordingTransport(1);
    expect(await deliver(flaky, "a")).toMatchObject({ failed: 1 });
    await activateLogo("a", "#15803d", 1); // the owner switches logo and colour meanwhile
    await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 60_000).toISOString() }).eq("entity_id", proposalId).eq("status", "pending"));
    expect(await deliver(flaky, "a")).toMatchObject({ sent: 1 });
    const [first, second] = flaky.messages;
    expect(second.html).toBe(first.html);
    expect(sha(inlineLogo(second)!.content)).toBe(sha(inlineLogo(first)!.content));
    expect(second.html).toContain("background:#be123c"); // the proposal's frozen colour
  });

  it("a retry keeps the reply-to of its first attempt; the owner's change applies to new emails", async () => {
    await must(owners.plain.db.rpc("update_reply_to_email", { p_tenant_id: shops.plain.tenantId, p_reply_to: `first-${run}@example.test` }));
    const proposalId = await sendProposal("plain");
    const flaky = new RecordingTransport(1);
    expect(await deliver(flaky, "plain")).toMatchObject({ failed: 1 });
    await must(owners.plain.db.rpc("update_reply_to_email", { p_tenant_id: shops.plain.tenantId, p_reply_to: `second-${run}@example.test` }));
    await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 60_000).toISOString() }).eq("entity_id", proposalId).eq("status", "pending"));
    expect(await deliver(flaky, "plain")).toMatchObject({ sent: 1 });
    expect(flaky.messages.map((m) => m.replyTo)).toEqual([`first-${run}@example.test`, `first-${run}@example.test`]);
    expect(flaky.messages[1].text).toContain("Reply to this email to reach IT it-mail-plain.");
    await sendProposal("plain");
    const fresh = new RecordingTransport();
    await deliver(fresh, "plain");
    expect(fresh.messages[0].replyTo).toBe(`second-${run}@example.test`);
  });

  it("a logo that can't be read leaves it out; the email still goes", async () => {
    const path = (await must(admin.from("tenants").select("logo_storage_path").eq("id", shops.b.tenantId).single())).data!.logo_storage_path!;
    await must(admin.storage.from(LOGO_BUCKET).remove([path]));
    await sendProposal("b");
    const mail = new RecordingTransport();
    expect(await deliver(mail, "b")).toMatchObject({ sent: 1, failed: 0 });
    expect(mail.messages[0].attachments).toBeUndefined();
    expect(mail.messages[0].html).toContain(">IT it-mail-b</td>");
  });
});

describe("Resend delivery webhooks", () => {
  let messageId = "";
  beforeAll(async () => {
    messageId = (await must(admin.from("email_outbox").select("provider_message_id").eq("tenant_id", shops.plain.tenantId).eq("status", "sent").limit(1).single())).data!.provider_message_id!;
  });

  it("refuses unsigned and wrongly signed requests and changes nothing", async () => {
    const event = { type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: messageId } };
    expect((await webhook(new Request("http://localhost/api/webhooks/resend", { method: "POST", body: JSON.stringify(event) }))).status).toBe(401);
    const forged = `whsec_${Buffer.from("not-the-secret").toString("base64")}`;
    expect((await webhook(signedRequest(event, forged))).status).toBe(401);
    expect((await outboxRow(messageId)).provider_status).toBeNull();
  });

  it("records delivery once, ignores late and duplicate events, and never schedules a retry after a bounce", async () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    expect((await webhook(signedRequest({ type: "email.delivered", created_at: at(1), data: { email_id: messageId } }))).status).toBe(200);
    expect((await webhook(signedRequest({ type: "email.delivered", created_at: at(1), data: { email_id: messageId } }))).status).toBe(200);
    expect((await webhook(signedRequest({ type: "email.delivery_delayed", created_at: at(0), data: { email_id: messageId } }))).status).toBe(200);
    expect(await outboxRow(messageId)).toMatchObject({ status: "sent", provider_status: "delivered" });
    expect((await webhook(signedRequest({ type: "email.opened", created_at: at(2), data: { email_id: messageId } }))).status).toBe(200);
    expect((await outboxRow(messageId)).provider_status).toBe("delivered");

    const before = await outboxRow(messageId);
    await webhook(signedRequest({ type: "email.bounced", created_at: at(3), data: { email_id: messageId, bounce: { type: "Permanent", subType: "General", message: "550 no such user" } } }));
    const after = await outboxRow(messageId);
    expect(after).toMatchObject({ status: "sent", provider_status: "bounced", provider_detail: "Permanent · General", attempts: before.attempts, next_attempt_at: before.next_attempt_at });
    // Business A's email is untouched by events for another business's message.
    expect((await outboxRow(messageA)).provider_status).toBeNull();
  });
});

