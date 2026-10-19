/**
 * Planning invitations for a normal Flux booking against the LOCAL stack,
 * through the real proposal, approval, contract, signature, deposit and
 * booking code, and the real outbox worker: nothing invites the client
 * automatically (booking, booking confirmation, planning setup); an unbooked
 * event can't be invited; once booked, staff send the planning invitation as
 * a separate email; the client who signed keeps their contract access and
 * opens planning without a second access grant; a delivery failure never
 * reads as sent. Dedicated it- tenant, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { deliveryState } from "@/lib/email/history";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { invitationStatus } from "@/lib/events/workspace";
import { contractInviteToken, planningInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { adminClient, archiveTestTenants, bothSeparate, createEvent, createTenantWithCatalog, draftAndSend, must, openLink, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { id: `rec-${this.messages.length}` };
  }
}

class FailingTransport implements EmailTransport {
  readonly name = "failing";
  async send(): Promise<{ id: string }> {
    throw new Error("Resend responded 503");
  }
}

const SECTIONS = [{ heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." }];
const run = randomUUID().slice(0, 8);
const clientEmail = `it-fluxplan-${run}@example.test`;
let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;
let eventId = "";
let client: { id: string; db: Db };

function signaturePng(): string {
  const w = 900, h = 300;
  const rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < 600; t++) {
    const x = 150 + t, y = Math.round(150 + Math.sin(t / 20) * 60);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${encodeRgbaPng(rgba, w, h).toString("base64")}`;
}

const invite = async () => {
  const id = randomUUID();
  const result = await staff.rpc("send_planning_invitation", { p_event_id: eventId, p_invitation_id: id, p_token_hash: sha256Hex(planningInviteToken(id)) });
  return { id, ...result };
};
const planningRows = async () =>
  (await must(admin.from("email_outbox").select("id, entity_id, event_type, status").eq("tenant_id", catalog.tenantId).eq("entity_type", "planning_invitation"))).data!;
const deliver = (transport: EmailTransport) => processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });

beforeAll(async () => {
  admin = adminClient();
  const owner = await signedInUser(admin, `it-fluxplan-owner-${run}@example.test`);
  staff = owner.db;
  catalog = await createTenantWithCatalog(admin, owner.id, "it-fluxplan");
  await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-fluxplan.example.test" }).eq("id", catalog.tenantId));
  const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT plan", p_title: "DEMO, NOT FOR CLIENT USE: Booking", p_sections: SECTIONS }));
  const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  versionId = version!.id;
  await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
});

afterAll(async () => {
  if (admin) await archiveTestTenants(admin, catalog?.tenantId);
});

describe("planning invitations for a Flux booking (local Supabase)", () => {
  it("an unbooked Flux event can't be invited, even with planning set up and a verified client", async () => {
    ({ eventId } = await createEvent(admin, catalog, clientEmail));
    await must(staff.rpc("install_starter_planning_templates", { p_tenant_id: catalog.tenantId }));
    const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", catalog.tenantId).eq("starter_key", "wedding").single());
    await must(staff.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
    const early = await invite();
    expect(early.error?.message).toMatch(/isn't booked yet/);
    expect(await planningRows()).toEqual([]);
  });

  it("booking (proposal, contract, signature, deposit) confirms the booking and invites nobody to planning", async () => {
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
    const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const linkId = randomUUID();
    await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
    client = await signedInUser(admin, clientEmail);
    await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
    const { data: row } = await must(admin.from("contracts").select("content_sha256, deposit_cents").eq("id", contractId).single());
    await must(staff.rpc("record_event_payment", {
      p_event_id: eventId, p_amount_cents: row!.deposit_cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
    }));
    expect(await signContractAs({
      userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: row!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    })).toMatchObject({ status: "signed" });

    const { data: event } = await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single());
    expect(event!.lifecycle_status).toBe("booked");
    const { count: bookingEmails } = await must(admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("event_type", "booking_confirmed").eq("entity_id", contractId));
    expect(bookingEmails).toBe(1);
    expect(await planningRows()).toEqual([]);
    const { count: invitations } = await must(admin.from("planning_invitations").select("id", { count: "exact", head: true }).eq("event_id", eventId));
    expect(invitations).toBe(0);
  }, 120_000);

  it("staff send the planning invitation as its own email; the signed-in client reuses their contract access", async () => {
    const sent = await invite();
    expect(sent.error).toBeNull();
    expect(sent.data).toMatchObject({ status: "sent", recipient_email: clientEmail });

    const mail = new RecordingTransport();
    await deliver(mail);
    const planning = mail.messages.filter((m) => m.subject === "It's time to plan your event!");
    expect(planning).toHaveLength(1);
    expect(planning[0].to).toBe(clientEmail);
    expect(planning[0].text).toContain("Open your planning portal");
    expect(planning[0].text).not.toMatch(/proposal|contract|deposit|payment/i);
    const link = new URL(/(https?:\/\/\S+\/planning-invite#\S+)/.exec(planning[0].text)![1]);
    expect(link.pathname).toBe(`/${catalog.slug}/planning-invite`);
    expect(link.hash.slice(1)).toBe(planningInviteToken(sent.id));
    // The booking confirmation is a different email, which says nothing about planning.
    const booking = mail.messages.find((m) => /is confirmed/.test(m.subject));
    if (booking) expect(booking.text).not.toMatch(/planning-invite|planning portal/i);
    const [row] = (await planningRows()).filter((r) => r.entity_id === sent.id);
    expect(row.status).toBe("sent");

    // The client signed in for the contract: already accepted, nothing to verify again.
    expect((await client.db.rpc("client_planning_invitation_status", { p_invitation_id: sent.id, p_tenant_slug: catalog.slug })).data).toMatchObject({ state: "accepted", event_id: eventId });
    expect((await client.db.rpc("accept_planning_invitation", { p_invitation_id: sent.id, p_tenant_slug: catalog.slug })).data).toEqual({ state: "accepted", event_id: eventId });
    const { count: access } = await must(admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId).eq("user_id", client.id).is("revoked_at", null));
    expect(access).toBe(1);
    const { data: view } = await must(client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }));
    const v = view as { state: string; basics: { item_id: string; revision: number } };
    expect(v.state).toBe("available");
    expect((await must(client.db.rpc("client_save_plan_item", { p_event_id: eventId, p_tenant_slug: catalog.slug, p_item_id: v.basics.item_id, p_expected_revision: v.basics.revision, p_answers: { guest_count: 150 } }))).data).toMatchObject({ status: "saved" });
    const { data: staffView } = await must(staff.rpc("staff_planning_view", { p_event_id: eventId }));
    expect((staffView as { basics: { answers: { guest_count?: number } } }).basics.answers.guest_count).toBe(150);

    // Another verified account is refused.
    const stranger = await signedInUser(admin, `it-fluxplan-stranger-${run}@example.test`);
    expect((await stranger.db.rpc("accept_planning_invitation", { p_invitation_id: sent.id, p_tenant_slug: catalog.slug })).data).toEqual({ state: "wrong_account" });
  }, 120_000);

  it("a failed delivery never reads as sent, and the replaced invitation stops working", async () => {
    const previous = (await planningRows()).find((r) => r.status === "sent")!.entity_id;
    const sent = await invite();
    expect(sent.error).toBeNull();
    const { data: old } = await must(admin.rpc("request_planning_sign_in", { p_token_hash: sha256Hex(planningInviteToken(previous)), p_tenant_slug: catalog.slug }));
    expect(old).toMatchObject({ status: "invalid" });

    await deliver(new FailingTransport());
    const { data: row } = await must(
      admin.from("email_outbox")
        .select("id, event_type, recipient_email, status, attempts, max_attempts, last_error, next_attempt_at, sent_at, created_at, provider_status, provider_status_at, provider_detail")
        .eq("entity_id", sent.id).eq("event_type", "planning_invitation").single(),
    );
    expect(row!.status).not.toBe("sent");
    const invitation = { id: sent.id, email: clientEmail, createdAt: row!.created_at, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revoked: false, accepted: false };
    expect(invitationStatus(invitation, row!, new Date()).label).toBe("Queued (retrying)");
    expect(deliveryState(row!).label).toBe("Retrying");
    // Every attempt used: failed, and shown as failed.
    await must(admin.from("email_outbox").update({ status: "failed" }).eq("id", row!.id));
    expect(invitationStatus(invitation, { ...row!, status: "failed" }, new Date())).toEqual({ label: "Failed", tone: "attention" });
  }, 120_000);
});
