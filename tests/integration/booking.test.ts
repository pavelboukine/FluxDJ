/**
 * Booking confirmation against the LOCAL stack, through the real API and the
 * real signing code: payments before signing, concurrent payments and
 * checks, the booking email (delivery, identical retries through the Resend
 * adapter, older workers). Dedicated test tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { processOutbox } from "@/lib/email/outbox.server";
import { ResendTransport } from "@/lib/email/transport.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { adminClient, bothSeparate, createEvent, createTenantWithCatalog, draftAndSend, must, openLink, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

const SECTIONS = [{ heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." }];
let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;

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

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const pay = (eventId: string, cents: number) =>
  staff.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: cents, p_paid_on: yesterday(), p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
  });
const eventState = async (eventId: string) =>
  (await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single())).data!;
const bookingRows = async (contractId: string) =>
  (await must(admin.from("email_outbox").select("id, status, recipient_email, payload").eq("event_type", "booking_confirmed").eq("entity_id", contractId))).data!;
const audits = async (eventId: string) =>
  (await must(admin.from("audit_events").select("id").eq("entity_id", eventId).eq("action", "booking_confirmed"))).data!.length;

/** A contract sent to a verified client, ready to sign. */
async function sentContract() {
  const clientEmail = `it-book-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId } = await createEvent(admin, catalog, clientEmail);
  const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  const { data: row } = await must(admin.from("contracts").select("content_sha256, deposit_cents, total_cents").eq("id", contractId).single());
  const sign = () =>
    signContractAs({
      userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: row!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    });
  return { eventId, contractId, clientEmail, deposit: row!.deposit_cents, total: row!.total_cents, sign };
}

describe("booking confirmation (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-book-owner-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-book");
    await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-book.example.test" }).eq("id", catalog.tenantId));
    const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT booking", p_title: "DEMO, NOT FOR CLIENT USE: Booking", p_sections: SECTIONS }));
    const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    versionId = version!.id;
    await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
  });

  afterAll(async () => {
    if (admin && catalog) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", catalog.tenantId);
  });

  it("a deposit paid before signing books the event when the client signs", async () => {
    const c = await sentContract();
    await must(pay(c.eventId, c.deposit));
    expect((await eventState(c.eventId)).lifecycle_status).toBe("awaiting_signature");
    expect(await c.sign()).toMatchObject({ status: "signed" });
    const state = await eventState(c.eventId);
    expect(state.lifecycle_status).toBe("booked");
    expect(state.booking_confirmed_at).not.toBeNull();
    const rows = await bookingRows(c.contractId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", recipient_email: c.clientEmail });
    expect(rows[0].payload).toMatchObject({ received_cents: c.deposit, remaining_cents: c.total - c.deposit });
  }, 120_000);

  it("concurrent payments and checks produce one booking, one audit event and one email", async () => {
    const c = await sentContract();
    await c.sign();
    expect((await eventState(c.eventId)).lifecycle_status).toBe("awaiting_deposit");
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => pay(c.eventId, c.deposit)),
      ...Array.from({ length: 3 }, () => staff.rpc("check_event_booking", { p_event_id: c.eventId })),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);
    const outcomes = results.map((r) => (r.data as { booking?: string; status: string }).booking ?? (r.data as { status: string }).status);
    expect(outcomes.filter((o) => o === "booked")).toHaveLength(1);
    expect(await audits(c.eventId)).toBe(1);
    expect(await bookingRows(c.contractId)).toHaveLength(1);
    const first = (await eventState(c.eventId)).booking_confirmed_at;
    await must(pay(c.eventId, 100));
    expect((await eventState(c.eventId)).booking_confirmed_at).toBe(first);
  }, 120_000);

  it("delivers the booking email once, with an identical request on retry, and older workers never claim it", async () => {
    const c = await sentContract();
    await must(pay(c.eventId, c.deposit));
    await c.sign();
    const [row] = await bookingRows(c.contractId);

    // A worker from before booking emails (claim without p_include_booking).
    const { data: oldClaim } = await must(admin.rpc("claim_email_outbox", { p_limit: 100, p_lock_seconds: 30, p_tenant_id: catalog.tenantId }));
    expect((oldClaim ?? []).some((r) => r.id === row.id)).toBe(false);
    expect((await must(admin.from("email_outbox").select("status").eq("id", row.id).single())).data!.status).toBe("pending");

    const { data: before } = await must(admin.from("tenants").select("display_name").eq("id", catalog.tenantId).single());
    const requests: { headers: Record<string, string>; body: string }[] = [];
    let providerUp = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.resend.com/emails") return realFetch(input, init);
      const headers = init!.headers as Record<string, string>;
      if (headers["Idempotency-Key"] === `flux-booking-${row.id}`) requests.push({ headers, body: init!.body as string });
      return providerUp ? new Response(JSON.stringify({ id: `resend-${requests.length}` }), { status: 200 }) : new Response("{}", { status: 503 });
    }) as typeof fetch;
    try {
      const transport = new ResendTransport("re_test_not_a_real_key");
      await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
      await must(admin.from("tenants").update({ display_name: "Renamed Booking DJ" }).eq("id", catalog.tenantId));
      providerUp = true;
      await must(admin.from("email_outbox").update({ next_attempt_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", row.id));
      await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
      expect(requests).toHaveLength(2);
      expect(requests[1].body).toBe(requests[0].body);
      expect(requests[1].headers).toEqual(requests[0].headers);
      const body = JSON.parse(requests[1].body) as { from: string; subject: string; text: string; attachments?: unknown };
      expect(body.from).toMatch(new RegExp(`^${before!.display_name} via Flux DJ <`));
      expect(body.subject).toMatch(/booking .* is confirmed/i);
      expect(body.text).toContain("Still to pay:");
      expect(body.text).not.toMatch(/planning|Renamed Booking DJ/i);
      expect(body.attachments).toBeUndefined();
      expect((await must(admin.from("email_outbox").select("status").eq("id", row.id).single())).data!.status).toBe("sent");
    } finally {
      globalThis.fetch = realFetch;
      await must(admin.from("tenants").update({ display_name: before!.display_name }).eq("id", catalog.tenantId));
    }
  }, 120_000);
});
