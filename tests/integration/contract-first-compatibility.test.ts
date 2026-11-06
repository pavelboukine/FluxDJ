/**
 * Contract-first compatibility against the LOCAL stack: direct contracts (no
 * proposal; stated terms or none) through the real API, signing code, PDF
 * renderer and outbox with a recording transport. There is no generator in this
 * release, so the fixture inserts the contract with the service role, through
 * the real triggers and constraints. Dedicated test tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processDocumentJobs, DOCUMENT_BUCKET } from "@/lib/contracts/documents.server";
import { clientContractViewSchema, contractReviewSchema, contractTerms } from "@/lib/contracts/responses";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { paymentOverview } from "@/lib/events/workspace";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { hubFacts, loadClientEvents } from "@/lib/client-event.server";
import { hubNextStep } from "@/lib/client-event";
import { clientPaymentSummarySchema, paymentSummarySchema } from "@/lib/payments";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { pdfPageTexts } from "../support/pdf";
import { adminClient, archiveTestTenants, bothSeparate, createEvent, createTenantWithCatalog, draftAndSend, must, openLink, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

const SECTIONS = [{ heading: "Terms", body: "Between {{business.legal_name}} and {{client.name}}." }];
const DIRECT_BODY = { schema_version: 1, title: "DEMO, NOT FOR CLIENT USE: Direct agreement", sections: [{ heading: "Terms", body: "We agree to the event." }] };

let admin: Db;
let staff: Db;
let otherStaff: Db;
let catalog: Catalog;
let otherCatalog: Catalog;
let ownerId: string;
let versionId: string;
let template: { template_id: string; content_sha256: string };

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

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { id: `rec-${this.messages.length}` };
  }
}

type Terms = { total: number; deposit: number; policy: "on_signature" | "on_deposit"; percent?: number } | null;

/** A contract-first event with a direct contract, sent to a verified client who has accepted the invitation. */
async function directContract(terms: Terms) {
  const clientEmail = `it-cf-${randomUUID().slice(0, 8)}@example.test`;
  const eventId = randomUUID();
  const clientId = randomUUID();
  await must(admin.from("clients").insert({ id: clientId, tenant_id: catalog.tenantId, name: "IT Client", email: clientEmail }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: catalog.tenantId, title: "IT direct", event_type: "wedding", event_date: "2027-06-12", contract_first: true }));
  await must(admin.from("events").update({ lifecycle_status: "awaiting_signature" }).eq("id", eventId));
  await must(admin.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  const { data: tenant } = await must(admin.from("tenants").select("business_name, display_name, business_address, contact_email").eq("id", catalog.tenantId).single());
  // Inserted with the service role, which can't override the business's required
  // deposit: only a signed-in owner can. So the fixture lifts the requirement
  // around the insert; the contract keeps the policy it states.
  await must(admin.from("tenants").update({ booking_confirmation_policy: "on_signature" }).eq("id", catalog.tenantId));
  const { data: inserted } = await must(
    admin.from("contracts").insert({
      tenant_id: catalog.tenantId, event_id: eventId, template_id: template.template_id, template_version_id: versionId, template_content_sha256: template.content_sha256,
      signer_client_id: clientId, signer_name: "IT Client", signer_email: clientEmail, currency: "CAD",
      total_cents: terms?.total ?? null, deposit_percent: terms?.percent ?? null, deposit_cents: terms?.deposit ?? null, balance_cents: terms ? terms.total - terms.deposit : null,
      booking_policy: terms?.policy ?? "on_signature",
      rendered_content: DIRECT_BODY,
      commercial_snapshot: terms
        ? { schema_version: 2, financial_terms: "stated", currency: "CAD", total_cents: terms.total, payment: { deposit_cents: terms.deposit, balance_cents: terms.total - terms.deposit, ...(terms.percent === undefined ? {} : { deposit_basis_points: terms.percent * 100 }) } }
        : { schema_version: 2, financial_terms: "none" },
      party_snapshot: {
        business: { name: tenant!.business_name, display_name: tenant!.display_name, legal_name: tenant!.business_name, address: tenant!.business_address, contact_email: tenant!.contact_email },
        client: { client_id: clientId, name: "IT Client", email: clientEmail, phone: null },
        event: { event_id: eventId, title: "IT direct", event_type: "wedding", date: "2027-06-12", timezone: "America/Toronto", venue_name: null, venue_address: null },
      },
      content_sha256: "0".repeat(64),
      // Set by the database from the template version, whatever is written here.
      signing_mode: "none",
      generated_by_user_id: ownerId,
    }).select("id, content_sha256, consent_version").single(),
  );
  await must(admin.from("tenants").update({ booking_confirmation_policy: "on_deposit" }).eq("id", catalog.tenantId));
  const contractId = inserted!.id;
  const linkId = randomUUID();
  await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  const accepted = await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  expect(accepted.data).toMatchObject({ state: "accepted", contract_id: contractId });
  const sign = () =>
    signContractAs({
      userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: inserted!.consent_version!, contentSha256: inserted!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    });
  return { eventId, contractId, linkId, clientEmail, client, sign };
}

const pay = (eventId: string, cents: number) =>
  staff.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
  });
const lifecycle = async (eventId: string) => (await must(admin.from("events").select("lifecycle_status").eq("id", eventId).single())).data!.lifecycle_status;

/** Renders this contract's signed PDF through the worker and returns its text. */
async function signedPdfText(contractId: string): Promise<string> {
  await processDocumentJobs({ admin, tenantId: catalog.tenantId, limit: 10 });
  const { data: doc } = await must(admin.from("contract_documents").select("storage_path").eq("contract_id", contractId).eq("kind", "signed_contract").single());
  const { data: blob } = await admin.storage.from(DOCUMENT_BUCKET).download(doc!.storage_path);
  return (await pdfPageTexts(Buffer.from(await blob!.arrayBuffer()))).join(" ");
}

async function delivered(clientEmail: string) {
  const transport = new RecordingTransport();
  await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
  return transport.messages.filter((m) => m.to === clientEmail);
}

describe("contract-first compatibility (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-cf-owner-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    ownerId = owner.id;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-cf");
    await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-cf.example.test" }).eq("id", catalog.tenantId));
    const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT direct", p_title: "DEMO, NOT FOR CLIENT USE: Direct", p_sections: SECTIONS }));
    const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    versionId = version!.id;
    await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
    const { data: published } = await must(admin.from("contract_template_versions").select("template_id, content_sha256").eq("id", versionId).single());
    template = { template_id: published!.template_id, content_sha256: published!.content_sha256! };
    const other = await signedInUser(admin, `it-cf-other-${randomUUID().slice(0, 8)}@example.test`);
    otherStaff = other.db;
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-cf-b");
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherCatalog?.tenantId);
  });

  it("a contract with no financial terms reads, signs, books and renders with no money anywhere", async () => {
    const c = await directContract(null);

    // Staff review, through the real schema.
    const { data: reviewData } = await must(staff.rpc("review_contract_for_send", { p_contract_id: c.contractId }));
    const review = contractReviewSchema.parse(reviewData);
    expect(review).toMatchObject({ source: "direct", total_cents: null, status: "sent" });

    // The client's view and hub.
    const { data: viewData } = await must(c.client.db.rpc("client_contract_view", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    const view = clientContractViewSchema.parse(viewData);
    if (view.state !== "available") throw new Error("the signer should see the contract");
    expect(contractTerms(view.contract)).toEqual({ financialTerms: "none", currency: "CAD" });
    const [facts] = await loadClientEvents(c.client.db, { slug: catalog.slug, eventId: c.eventId });
    expect(facts.contract).toMatchObject({ source: "direct", terms: { financialTerms: "none" } });
    expect(hubNextStep(hubFacts(facts)).text).toBe(`Read the agreement from IT it-cf, then sign online.`);

    // No proposal to read.
    const { data: offer } = await must(c.client.db.rpc("client_approved_offer", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    expect(offer).toEqual({ state: "unavailable" });

    // The invitation email goes out before signing (signing retires any still queued).
    const invite = (await delivered(c.clientEmail)).find((m) => /sent your contract/i.test(m.subject));
    expect(invite).toBeDefined();

    expect(await c.sign()).toMatchObject({ status: "signed" });
    expect(await lifecycle(c.eventId)).toBe("booked");

    // Summaries: no figures, and never "paid in full".
    const { data: summaryData } = await must(staff.rpc("event_payment_summary", { p_event_id: c.eventId }));
    const summary = paymentSummarySchema.parse(summaryData);
    expect(summary).toMatchObject({ terms: null, no_financial_terms: true, remaining_balance_cents: null, deposit_outstanding_cents: null, credit_cents: null });
    expect(paymentOverview(summary)).toEqual({ figures: null, next: null });
    const { data: clientSummary } = await must(c.client.db.rpc("client_payment_summary", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    expect(clientPaymentSummarySchema.parse(clientSummary)).toMatchObject({ booking_status: "booked", total_cents: null, remaining_balance_cents: null });

    // The signed PDF, rendered by the worker.
    const text = await signedPdfText(c.contractId);
    expect(text).toContain("We agree to the event.");
    expect(text).toContain("Client signature");
    expect(text).toContain("Signing record");
    expect(text).not.toMatch(/Agreed price|Subtotal|Deposit|Balance|0\.00/);

    // The emails the client actually receives.
    const booked = (await delivered(c.clientEmail)).find((m) => /booking .* is confirmed/i.test(m.subject));
    expect(booked).toBeDefined();
    for (const m of [invite!, booked!]) expect(m.text).not.toMatch(/Deposit|0\.00|% of the total|Paid in full|Nothing remains|Still to pay|Total/);
    expect(booked!.text).toContain("has confirmed your booking");
  }, 180_000);

  it("a direct contract with a required deposit waits for it, then states real figures", async () => {
    const c = await directContract({ total: 100_000, deposit: 50_000, policy: "on_deposit", percent: 50 });
    expect(await c.sign()).toMatchObject({ status: "signed" });
    expect(await lifecycle(c.eventId)).toBe("awaiting_deposit");
    await must(pay(c.eventId, 49_999));
    expect(await lifecycle(c.eventId)).toBe("awaiting_deposit");
    await must(pay(c.eventId, 1));
    expect(await lifecycle(c.eventId)).toBe("booked");

    const { data: summaryData } = await must(staff.rpc("event_payment_summary", { p_event_id: c.eventId }));
    const summary = paymentSummarySchema.parse(summaryData);
    expect(summary.no_financial_terms).toBeUndefined();
    expect(summary).toMatchObject({ remaining_balance_cents: 50_000, deposit_outstanding_cents: 0 });

    const text = await signedPdfText(c.contractId);
    expect(text).toContain("Agreed price and payment terms");
    expect(text).toContain("1,000.00");
    expect(text).toContain("(50%)");
    expect(text).not.toMatch(/Subtotal|Unit price/);
  }, 180_000);

  it("a stated deposit with no percentage reads, and its email has no invented percentage", async () => {
    const c = await directContract({ total: 100_000, deposit: 20_000, policy: "on_deposit" });
    const { data: viewData } = await must(c.client.db.rpc("client_contract_view", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    const view = clientContractViewSchema.parse(viewData);
    if (view.state !== "available") throw new Error("the signer should see the contract");
    expect(contractTerms(view.contract)).toMatchObject({ direct: true, depositPercent: null, depositCents: 20_000 });
    const invite = (await delivered(c.clientEmail)).find((m) => /sent your contract/i.test(m.subject));
    expect(invite!.text).toContain("200.00");
    expect(invite!.text).not.toMatch(/% of the total|null/);
  }, 120_000);

  it("a genuine $0 contract stays a real zero, unlike one with no terms", async () => {
    const c = await directContract({ total: 0, deposit: 0, policy: "on_signature" });
    expect(await c.sign()).toMatchObject({ status: "signed" });
    expect(await lifecycle(c.eventId)).toBe("booked");
    const { data: summaryData } = await must(staff.rpc("event_payment_summary", { p_event_id: c.eventId }));
    const summary = paymentSummarySchema.parse(summaryData);
    expect(summary.no_financial_terms).toBeUndefined();
    expect(summary.terms).toMatchObject({ total_cents: 0 });
    const booked = (await delivered(c.clientEmail)).find((m) => /booking .* is confirmed/i.test(m.subject));
    expect(booked!.text).toContain("Nothing remains to be paid.");
  }, 120_000);

  it("rejects other businesses and other clients", async () => {
    const c = await directContract(null);
    expect((await otherStaff.rpc("review_contract_for_send", { p_contract_id: c.contractId })).error?.code).toBe("P0002");
    expect((await otherStaff.rpc("event_payment_summary", { p_event_id: c.eventId })).error?.code).toBe("P0002");
    expect((await otherStaff.from("contracts").select("id").eq("id", c.contractId)).data).toEqual([]);
    const { data: wrongSlug } = await must(c.client.db.rpc("client_contract_view", { p_contract_id: c.contractId, p_tenant_slug: otherCatalog.slug }));
    expect(wrongSlug).toEqual({ state: "unavailable" });
    const stranger = await signedInUser(admin, `it-cf-stranger-${randomUUID().slice(0, 8)}@example.test`);
    const { data: strangerView } = await must(stranger.db.rpc("client_contract_view", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    expect(strangerView).toEqual({ state: "unavailable" });
    const { data: accepted } = await must(stranger.db.rpc("accept_contract_invitation", { p_link_id: c.linkId, p_tenant_slug: catalog.slug }));
    expect(accepted).toMatchObject({ state: "wrong_account" });
    // Nor can staff give themselves the flag.
    const { error } = await staff.from("events").insert({ tenant_id: catalog.tenantId, title: "Nope", event_type: "party", event_date: "2027-01-01", contract_first: true });
    expect(error?.code).toBe("42501");
  }, 120_000);

  it("a proposal-backed contract's responses have no new keys and its terms read as before", async () => {
    const clientEmail = `it-cf-backed-${randomUUID().slice(0, 8)}@example.test`;
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

    const { data: viewData } = await must(client.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect((viewData as { contract: Record<string, unknown> }).contract).not.toHaveProperty("source");
    const view = clientContractViewSchema.parse(viewData);
    if (view.state !== "available") throw new Error("the signer should see the contract");
    expect(contractTerms(view.contract)).toMatchObject({ financialTerms: "stated", direct: false, depositPercent: 50 });

    const { data: summary } = await must(staff.rpc("event_payment_summary", { p_event_id: eventId }));
    expect(summary).not.toHaveProperty("no_financial_terms");
    const { data: review } = await must(staff.rpc("review_contract_for_send", { p_contract_id: contractId }));
    expect(review).not.toHaveProperty("source");

    const [facts] = await loadClientEvents(client.db, { slug: catalog.slug, eventId });
    expect(facts.contract?.source).toBe("proposal");
    const invite = (await delivered(clientEmail)).find((m) => /sent your contract/i.test(m.subject));
    expect(invite!.text).toContain("(50% of the total)");
  }, 180_000);
});
