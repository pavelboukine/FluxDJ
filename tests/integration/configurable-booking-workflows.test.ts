/**
 * Configurable booking workflows against the LOCAL stack: creating a contract-first
 * event, generate_direct_contract_draft through the real API and schemas, and the
 * whole path through invitation, signing, booking, planning, the PDF worker and the
 * outbox (with a recording transport). Dedicated test tenants; nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processDocumentJobs, DOCUMENT_BUCKET } from "@/lib/contracts/documents.server";
import { clientContractViewSchema, contractReviewSchema, contractTerms, generateDirectContractResultSchema } from "@/lib/contracts/responses";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { pdfPageTexts } from "../support/pdf";
import { adminClient, archiveTestTenants, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

let admin: Db;
let owner: Db;
let staffMember: Db;
let otherOwner: Db;
let catalog: Catalog;
let otherCatalog: Catalog;
const versions: Record<string, string> = {};

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

async function publish(name: string, sections: { heading: string; body: string }[]) {
  const { data: templateId } = await must(owner.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: name, p_title: `Agreement: ${name}`, p_sections: sections }));
  const { data: version } = await must(owner.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  const { data: statement } = await must(owner.rpc("client_use_statement_current"));
  await must(owner.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "client_use", p_client_use_statement_version: (statement as { version: string }).version }));
  versions[name] = version!.id;
}

/** A contract-first event, created the way staff create one: through their own session, under RLS. */
async function contractFirstEvent(db: Db = owner) {
  const clientEmail = `it-wf-${randomUUID().slice(0, 8)}@example.test`;
  const clientId = randomUUID();
  await must(admin.from("clients").insert({ id: clientId, tenant_id: catalog.tenantId, name: "IT Client", email: clientEmail }));
  const { data: event } = await must(db.from("events").insert({ tenant_id: catalog.tenantId, title: "IT workflow", event_type: "wedding", event_date: "2027-06-12", timezone: "America/Toronto", contract_first: true }).select("id").single());
  await must(admin.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: event!.id, client_id: clientId, is_primary: true, can_sign: true }));
  return { eventId: event!.id, clientEmail };
}

const generate = (db: Db, eventId: string, version: string, args: Record<string, unknown> = {}) =>
  db.rpc("generate_direct_contract_draft", { p_event_id: eventId, p_template_version_id: versions[version], ...args });

async function sendAndAccept(contractId: string, clientEmail: string) {
  const linkId = randomUUID();
  await must(owner.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  const accepted = await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  expect(accepted.data).toMatchObject({ state: "accepted", contract_id: contractId });
  return client;
}

async function sign(client: Awaited<ReturnType<typeof signedInUser>>, contractId: string, over: { typedName?: string; signature?: string; consentAccepted?: boolean } = {}) {
  const { data: c } = await must(admin.from("contracts").select("consent_version, content_sha256").eq("id", contractId).single());
  return signContractAs({
    userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
    input: { typedName: "IT Signer", consentAccepted: true, consentVersion: c!.consent_version!, contentSha256: c!.content_sha256, signature: signaturePng(), ...over },
    request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
  });
}

const pay = (eventId: string, cents: number) =>
  owner.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
  });
const eventRow = async (eventId: string) => (await must(admin.from("events").select("lifecycle_status, booking_confirmed_at, active_proposal_id").eq("id", eventId).single())).data!;

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

describe("configurable booking workflows (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const ownerUser = await signedInUser(admin, `it-wf-owner-${randomUUID().slice(0, 8)}@example.test`);
    owner = ownerUser.db;
    catalog = await createTenantWithCatalog(admin, ownerUser.id, "it-wf");
    await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-wf.example.test" }).eq("id", catalog.tenantId));
    const staffUser = await signedInUser(admin, `it-wf-staff-${randomUUID().slice(0, 8)}@example.test`);
    staffMember = staffUser.db;
    await must(admin.from("tenant_memberships").insert({ tenant_id: catalog.tenantId, user_id: staffUser.id, role: "staff" }));
    await publish("none", [{ heading: "Terms", body: "Between {{business.legal_name}} and {{client.name}} for {{event.title}}." }]);
    await publish("priced", [{ heading: "Price", body: "Total: {{pricing.total}}. Deposit due on signing: {{payment.deposit}}. Balance: {{payment.balance}}." }]);
    await publish("package", [{ heading: "Package", body: "{{package.name}} at {{package.price}}." }]);
    await publish("services", [{ heading: "Services", body: "{{contract.services}}" }]);
    const other = await signedInUser(admin, `it-wf-other-${randomUUID().slice(0, 8)}@example.test`);
    otherOwner = other.db;
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-wf-b");
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherCatalog?.tenantId);
  });

  it("staff create a contract-first event under RLS, and it needs its own business", async () => {
    const { eventId } = await contractFirstEvent(staffMember);
    expect((await must(admin.from("events").select("contract_first, booking_source, lifecycle_status").eq("id", eventId).single())).data).toEqual({ contract_first: true, booking_source: "flux", lifecycle_status: "lead" });
    const wrong = await otherOwner.from("events").insert({ tenant_id: catalog.tenantId, title: "No", event_type: "wedding", event_date: "2027-06-12", timezone: "America/Toronto", contract_first: true });
    expect(wrong.error?.code).toBe("42501");
    const external = await owner.from("events").insert({ tenant_id: catalog.tenantId, title: "No", event_type: "wedding", event_date: "2027-06-12", timezone: "America/Toronto", booking_source: "external", contract_first: true });
    expect(external.error?.code).toBe("23514");
    expect((await owner.from("events").update({ contract_first: false }).eq("id", eventId)).error?.code).toBe("42501");
  });

  it("corrects the workflow until something has started, then refuses", async () => {
    const { eventId } = await contractFirstEvent();
    expect((await must(owner.rpc("set_event_contract_first", { p_event_id: eventId, p_contract_first: false }))).data).toMatchObject({ status: "changed" });
    expect((await must(owner.rpc("set_event_contract_first", { p_event_id: eventId, p_contract_first: true }))).data).toMatchObject({ status: "changed" });
    await must(generate(owner, eventId, "none", { p_override_deposit: true }));
    const refused = await owner.rpc("set_event_contract_first", { p_event_id: eventId, p_contract_first: false });
    expect(refused.error?.message).toContain("can't change once");
  });

  it("validates the template's fields against the terms, and stores nothing when incomplete", async () => {
    const { eventId } = await contractFirstEvent();
    const parse = async (version: string, args: Record<string, unknown> = {}) => generateDirectContractResultSchema.parse((await must(generate(owner, eventId, version, args))).data);
    const missing = async (version: string, args: Record<string, unknown>) => {
      const r = await parse(version, args);
      if (r.status !== "incomplete") throw new Error(`expected incomplete, got ${r.status}`);
      return r.missing;
    };
    expect((await missing("package", { p_override_deposit: true })).map((m) => m.key)).toEqual(["package.name", "package.price"]);
    expect((await missing("package", { p_override_deposit: true }))[0].hint).toContain("approved proposal");
    expect((await missing("priced", { p_override_deposit: true })).map((m) => m.key)).toEqual(["pricing.total", "payment.deposit", "payment.balance"]);
    expect((await missing("none", { p_total_cents: 100_000, p_deposit_cents: 50_000 })).map((m) => m.key)).toEqual(["terms.total", "terms.deposit"]);
    expect((await missing("services", { p_override_deposit: true })).map((m) => m.key)).toEqual(["contract.services"]);
    expect((await must(admin.from("contracts").select("id").eq("event_id", eventId))).data).toEqual([]);
    expect((await eventRow(eventId)).lifecycle_status).toBe("lead");
  });

  it("enforces the deposit rule from the signed-in user's role", async () => {
    const { eventId } = await contractFirstEvent();
    const staffTry = await generate(staffMember, eventId, "none", { p_override_deposit: true });
    expect(staffTry.error?.code).toBe("42501");
    expect(staffTry.error?.message).toContain("Only the owner can go below it");
    for (const args of [{ p_total_cents: 100_000, p_deposit_cents: 49_999 }, { p_total_cents: 0, p_deposit_cents: 0 }]) {
      expect((await generate(staffMember, eventId, "priced", { ...args, p_override_deposit: true })).error?.code).toBe("42501");
    }
    expect((await must(generate(owner, eventId, "none"))).data).toMatchObject({ status: "override_required", deposit_percent: 50 });
    expect((await must(generate(staffMember, eventId, "priced", { p_total_cents: 100_000, p_deposit_cents: 50_000 }))).data).toMatchObject({ status: "created" });
  });

  it("rejects other businesses", async () => {
    const { eventId } = await contractFirstEvent();
    expect((await generate(otherOwner, eventId, "none", { p_override_deposit: true })).error?.code).toBe("P0002");
    expect((await otherOwner.rpc("set_event_contract_first", { p_event_id: eventId, p_contract_first: false })).error?.code).toBe("P0002");
    const { data: other } = await must(otherOwner.from("events").insert({ tenant_id: otherCatalog.tenantId, title: "Other", event_type: "wedding", event_date: "2027-06-12", timezone: "America/Toronto", contract_first: true }).select("id").single());
    expect((await generate(otherOwner, other!.id, "none", { p_override_deposit: true })).error?.message).toContain("template version not found");
  });

  it("no financial terms: generates, sends, signs, books at once and opens planning, with no money anywhere", async () => {
    const { eventId, clientEmail } = await contractFirstEvent();
    const generated = generateDirectContractResultSchema.parse((await must(generate(owner, eventId, "none", { p_override_deposit: true }))).data);
    if (generated.status !== "created") throw new Error(generated.status);
    const contractId = generated.contract_id;
    const row = (await must(admin.from("contracts").select("proposal_id, selection_id, approval_id, total_cents, deposit_cents, balance_cents, deposit_percent, booking_policy, signing_mode, consent_version, commercial_snapshot").eq("id", contractId).single())).data!;
    expect(row).toEqual({ proposal_id: null, selection_id: null, approval_id: null, total_cents: null, deposit_cents: null, balance_cents: null, deposit_percent: null, booking_policy: "on_signature", signing_mode: "client_use", consent_version: "client-no-terms-v1", commercial_snapshot: { schema_version: 2, financial_terms: "none" } });
    expect((await eventRow(eventId)).active_proposal_id).toBeNull();

    const review = contractReviewSchema.parse((await must(owner.rpc("review_contract_for_send", { p_contract_id: contractId }))).data);
    expect(review).toMatchObject({ can_send: true, source: "direct", total_cents: null });

    const client = await sendAndAccept(contractId, clientEmail);
    const view = clientContractViewSchema.parse((await must(client.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }))).data);
    if (view.state !== "available" || view.contract.status !== "sent" || view.signing.signed) throw new Error("the signer should be able to sign");
    expect(contractTerms(view.contract)).toEqual({ financialTerms: "none", currency: "CAD" });
    expect(view.signing).toMatchObject({ enabled: true, consent_version: "client-no-terms-v1" });
    expect(view.signing.consent_text).toContain("I have read the entire agreement shown above.");
    expect(view.signing.consent_text).not.toContain("payment");

    const invite = (await delivered(clientEmail)).find((m) => /sent your contract/i.test(m.subject));
    expect(invite!.text).not.toMatch(/Deposit|0\.00|% of the total/);

    // What the consent statement says happens: a typed name and a drawn signature are both required.
    expect(await sign(client, contractId, { typedName: "  " })).toMatchObject({ status: "error", code: "name_required" });
    const blank = `data:image/png;base64,${encodeRgbaPng(Buffer.alloc(900 * 300 * 4), 900, 300).toString("base64")}`;
    expect(await sign(client, contractId, { signature: blank })).toMatchObject({ status: "error" });
    expect(await sign(client, contractId, { consentAccepted: false })).toMatchObject({ status: "error", code: "consent_required" });
    expect((await eventRow(eventId)).lifecycle_status).toBe("awaiting_signature");

    expect(await sign(client, contractId)).toMatchObject({ status: "signed" });
    const booked = await eventRow(eventId);
    expect(booked.lifecycle_status).toBe("booked");
    expect(booked.booking_confirmed_at).not.toBeNull();
    expect((await must(admin.from("event_payments").select("id").eq("event_id", eventId))).data).toEqual([]);
    expect((await must(admin.from("event_plans").select("id").eq("event_id", eventId))).data).toHaveLength(1);
    const { data: access } = await must(admin.from("event_access").select("id").eq("event_id", eventId).is("revoked_at", null));
    expect(access).toHaveLength(1);

    const text = await signedPdfText(contractId);
    expect(text).toContain("for IT workflow");
    expect(text).not.toMatch(/Agreed price|Deposit|Balance|0\.00/);
    const afterSigning = await delivered(clientEmail);
    const confirmation = afterSigning.find((m) => /booking .* is confirmed/i.test(m.subject));
    expect(confirmation!.text).toContain("has confirmed your booking");
    expect(confirmation!.text).not.toMatch(/Paid in full|Nothing remains|Still to pay|0\.00/);

    // "I can download a copy of the signed agreement here, and a copy will be emailed to me."
    const { data: signature } = await must(admin.from("contract_signatures").select("consent_version, consent_text, typed_name").eq("contract_id", contractId).single());
    expect(signature).toMatchObject({ consent_version: "client-no-terms-v1", typed_name: "IT Signer", consent_text: view.signing.consent_text });
    const { data: document } = await must(client.db.rpc("client_signed_document", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(JSON.stringify(document)).toContain(".pdf");
    const copy = afterSigning.find((m) => m.attachments?.some((a) => a.contentType === "application/pdf"));
    expect(copy).toBeDefined();
  }, 180_000);

  it("a business that confirms on signature needs no exception, and staff can use no-money contracts", async () => {
    const { data: tenant } = await must(admin.from("tenants").select("booking_policy_version").eq("id", catalog.tenantId).single());
    await must(owner.rpc("update_booking_policy", { p_tenant_id: catalog.tenantId, p_policy: "on_signature", p_expected_version: tenant!.booking_policy_version }));
    try {
      const { eventId } = await contractFirstEvent(staffMember);
      const { data } = await must(generate(staffMember, eventId, "none"));
      const contractId = (data as { status: string; contract_id: string }).contract_id;
      expect(data).toMatchObject({ status: "created" });
      expect((await must(admin.from("audit_events").select("id").eq("entity_id", contractId).eq("action", "deposit_requirement_overridden"))).data).toEqual([]);
      expect((await must(admin.from("contracts").select("total_cents, booking_policy").eq("id", contractId).single())).data).toEqual({ total_cents: null, booking_policy: "on_signature" });
    } finally {
      await must(owner.rpc("update_booking_policy", { p_tenant_id: catalog.tenantId, p_policy: "on_deposit", p_expected_version: tenant!.booking_policy_version + 1 }));
    }
  });

  it("a required deposit: the agreement states it, and only the payment that reaches it books", async () => {
    const { eventId, clientEmail } = await contractFirstEvent();
    const { data } = await must(generate(owner, eventId, "priced", { p_total_cents: 100_000, p_deposit_cents: 50_000 }));
    const contractId = (data as { contract_id: string }).contract_id;
    const row = (await must(admin.from("contracts").select("rendered_content, deposit_percent, booking_policy, consent_version").eq("id", contractId).single())).data!;
    expect(JSON.stringify(row.rendered_content)).toContain("Total: 1,000.00 CAD. Deposit due on signing: 500.00 CAD. Balance: 500.00 CAD.");
    expect(row).toMatchObject({ deposit_percent: 50, booking_policy: "on_deposit", consent_version: "client-v1" });
    const client = await sendAndAccept(contractId, clientEmail);
    expect(await sign(client, contractId)).toMatchObject({ status: "signed" });
    expect((await eventRow(eventId)).lifecycle_status).toBe("awaiting_deposit");
    await must(pay(eventId, 49_999));
    expect((await eventRow(eventId)).lifecycle_status).toBe("awaiting_deposit");
    await must(pay(eventId, 1));
    expect((await eventRow(eventId)).lifecycle_status).toBe("booked");
    expect((await must(admin.from("event_plans").select("id").eq("event_id", eventId))).data).toHaveLength(1);
    const text = await signedPdfText(contractId);
    expect(text).toContain("500.00");
    expect(text).toContain("Deposit due on signing (50%)");
  }, 180_000);

  it("an owner's stated price with no deposit books on signature and shows no deposit in its PDF or email", async () => {
    const { eventId, clientEmail } = await contractFirstEvent();
    const { data } = await must(generate(owner, eventId, "priced", { p_total_cents: 100_000, p_override_deposit: true }));
    const contractId = (data as { contract_id: string }).contract_id;
    const client = await sendAndAccept(contractId, clientEmail);
    const invite = (await delivered(clientEmail)).find((m) => /sent your contract/i.test(m.subject));
    expect(invite!.text).not.toContain("Deposit due on signing");
    expect(await sign(client, contractId)).toMatchObject({ status: "signed" });
    expect((await eventRow(eventId)).lifecycle_status).toBe("booked");
    expect(await signedPdfText(contractId)).toContain("No deposit");
    const { data: audit } = await must(admin.from("audit_events").select("action").eq("entity_id", contractId).eq("action", "deposit_requirement_overridden"));
    expect(audit).toHaveLength(1);
  }, 180_000);

  it("services are printed in the agreement the client signs", async () => {
    const { eventId } = await contractFirstEvent();
    const { data } = await must(generate(owner, eventId, "services", { p_services: "DJ and sound, 6 hours", p_override_deposit: true }));
    const { data: row } = await must(admin.from("contracts").select("rendered_content").eq("id", (data as { contract_id: string }).contract_id).single());
    expect(JSON.stringify(row!.rendered_content)).toContain("DJ and sound, 6 hours");
  });
});
