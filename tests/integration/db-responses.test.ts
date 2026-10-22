/**
 * The schemas that guard database responses (lib/db-response.ts and its
 * users) against the LOCAL database's real answers: every response of a
 * proposal, contract, signing and payment flow, discounted and not, parses,
 * so the schemas can't drift from the functions they describe. Also the safe
 * failure when a signing commit succeeds but its answer is malformed: nothing
 * reported as signed, the referenced signature image kept, and a retry
 * replaying the committed signature. Dedicated it- tenant, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { approvedOfferSchema, clientContractViewSchema, contractReviewSchema, generateContractResultSchema, signContractResultSchema } from "@/lib/contracts/responses";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { SIGNATURE_BUCKET } from "@/lib/contracts/signing";
import { clientPaymentSummarySchema, discountBreakdown, paymentSummarySchema } from "@/lib/payments";
import { selectionRecordSchema } from "@/lib/pricing";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import type { Json } from "@/lib/supabase/database.types";
import { adminClient, archiveTestTenants, bothSeparate, createEvent, createTenantWithCatalog, must, openLink, sendDraft, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

const run = randomUUID().slice(0, 8);
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

/** The real admin client, except that sign_contract's answer (after the real commit) loses its contract id. */
function mangledSignAnswer(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "rpc") {
        return async (name: string, ...args: unknown[]) => {
          const result = await (target.rpc as unknown as (...a: unknown[]) => PromiseLike<{ data: unknown }>)(name, ...args);
          return name === "sign_contract" ? { ...result, data: { ...(result.data as object), contract_id: undefined } } : result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

/** A proposal (discounted or not) taken to a sent contract, its client signed in with access. */
async function sentContract(discount: Record<string, unknown> | null) {
  const clientEmail = `it-shapes-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId } = await createEvent(admin, catalog, clientEmail);

  // No contract yet: the staff summary has no terms.
  const { data: early } = await must(staff.rpc("event_payment_summary", { p_event_id: eventId }));
  expect(paymentSummarySchema.parse(early).terms).toBeNull();

  const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
  const offer = { ...(input as Record<string, Json>), ...(discount ? { discount: discount as Json } : {}) };
  const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: offer }));
  const { token } = await sendDraft(staff, proposalId as string);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const submitted = await submit(admin, { slug: catalog.slug, proposalId: proposalId as string, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });

  // The client's proposal view returns the stored record exactly as the schema expects it.
  const { data: view } = await must(admin.rpc("client_proposal_view", { p_session_hash: sessionHash, p_proposal_id: proposalId as string, p_tenant_slug: catalog.slug }));
  const record = selectionRecordSchema.parse((view as { submission: { selection: unknown } }).submission.selection);
  expect(record.offer_sha256).toMatch(/^[0-9a-f]{64}$/);

  const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId as string, p_selection_id: submitted.selection_id as string }));
  const approvalId = (approval as { approval_id: string }).approval_id;
  const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId }));
  const created = generateContractResultSchema.parse(generated);
  if (created.status !== "created") throw new Error(`generation: ${created.status}`);
  const contractId = created.contract_id;
  // Asking again for the same approval and version replays the same draft.
  const { data: again } = await must(staff.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId }));
  expect(generateContractResultSchema.parse(again)).toEqual({ status: "replayed", contract_id: contractId });

  const { data: review } = await must(staff.rpc("review_contract_for_send", { p_contract_id: contractId }));
  expect(contractReviewSchema.parse(review)).toMatchObject({ status: "draft", eligible: true, can_send: true });

  const linkId = randomUUID();
  await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  return { eventId, contractId, client };
}

beforeAll(async () => {
  admin = adminClient();
  const owner = await signedInUser(admin, `it-shapes-owner-${run}@example.test`);
  staff = owner.db;
  catalog = await createTenantWithCatalog(admin, owner.id, "it-shapes");
  await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-shapes.example.test" }).eq("id", catalog.tenantId));
  const sections = [{ heading: "Payment", body: "Deposit ({{payment.deposit_percent}}): {{payment.deposit}}. Balance {{payment.balance}}. Total {{pricing.total}}." }];
  const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT shapes", p_title: "DEMO, NOT FOR CLIENT USE: Booking", p_sections: sections }));
  const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  versionId = version!.id;
  await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
});

afterAll(async () => {
  if (admin) await archiveTestTenants(admin, catalog?.tenantId);
});

describe("database responses satisfy the app's schemas (local Supabase)", () => {
  it("a discounted contract: sent and signed views, payment summaries, the approved offer and a malformed signing answer", async () => {
    const { eventId, contractId, client } = await sentContract({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" });
    const read = async () => {
      const [{ data: view }, { data: summary }, { data: staffSummary }] = await Promise.all([
        must(client.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug })),
        must(client.db.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: catalog.slug })),
        must(staff.rpc("event_payment_summary", { p_event_id: eventId })),
      ]);
      return { view: clientContractViewSchema.parse(view), summary: clientPaymentSummarySchema.parse(summary), staffSummary: paymentSummarySchema.parse(staffSummary) };
    };

    const sent = await read();
    if (sent.view.state !== "available") throw new Error("contract unavailable");
    expect(sent.view.signing).toMatchObject({ signed: false, enabled: true, consent_version: "demo-v1" });
    expect(sent.summary).toMatchObject({ terms_status: "sent", booking_status: null, pricing: { discount: { amount_cents: 23_500 } } });
    expect(discountBreakdown(sent.summary.pricing)?.discountedSubtotalCents).toBe(211_500);
    expect(sent.staffSummary.terms).toMatchObject({ status: "sent", contract_id: contractId });
    const { data: approvedEarly } = await must(client.db.rpc("client_approved_offer", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(approvedOfferSchema.parse(approvedEarly)).toMatchObject({ state: "available", event_id: eventId, contract: { status: "sent" } });

    // The commit succeeds but its answer is malformed: reported as unconfirmed, never as signed with missing details.
    const input = { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: sent.view.contract.content_sha256, signature: signaturePng() };
    const request = { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" as const };
    // Every effect signing can have: the signature, its audit event, the PDF job (which later sends the
    // copies), emails for the contract and the event's booking state.
    const count = async (table: "contract_signatures" | "document_jobs", column = "contract_id") =>
      (await must(admin.from(table).select("id", { count: "exact", head: true }).eq(column, contractId))).count;
    const effects = async () => ({
      signatures: await count("contract_signatures"),
      audits: (await must(admin.from("audit_events").select("id", { count: "exact", head: true }).eq("entity_id", contractId).eq("action", "signed"))).count,
      pdfJobs: await count("document_jobs"),
      emails: (await must(admin.from("email_outbox").select("id, event_type").eq("tenant_id", catalog.tenantId).order("created_at"))).data,
      event: (await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single())).data,
      contract: (await must(admin.from("contracts").select("status, signed_at").eq("id", contractId).single())).data,
    });
    const before = await effects();
    const first = await signContractAs({ userDb: client.db, userId: client.id, admin: mangledSignAnswer(admin), slug: catalog.slug, contractId, input, request });
    expect(first).toEqual({ status: "error", code: "network", message: "We couldn't confirm your signature. Try again; you won't sign twice." });
    // It was committed, and the image it references was kept.
    const { data: signature } = await must(admin.from("contract_signatures").select("signature_path").eq("contract_id", contractId).single());
    const folder = signature!.signature_path.split("/").slice(0, 2).join("/");
    const listed = async () => ((await admin.storage.from(SIGNATURE_BUCKET).list(folder)).data ?? []).map((o) => `${folder}/${o.name}`);
    expect(await listed()).toEqual([signature!.signature_path]);

    // The retry gets the committed signature back as a replay, and its own upload is discarded.
    const retry = await signContractAs({ userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId, input, request });
    expect(retry).toMatchObject({ status: "signed", contractId, typedName: "IT Signer", replayed: true });
    expect(await listed()).toEqual([signature!.signature_path]);
    // The committed signature: one of each effect, none from the retries (a different name changes nothing).
    const committed = await effects();
    expect(committed).toMatchObject({ signatures: 1, audits: 1, pdfJobs: 1, contract: { status: "signed" }, event: { lifecycle_status: "awaiting_deposit", booking_confirmed_at: null } });
    expect(committed.emails).toEqual(before.emails);
    expect(retry).toMatchObject({ signedAt: committed.contract!.signed_at });
    expect(await signContractAs({ userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId, input: { ...input, typedName: "Someone Else" }, request }))
      .toMatchObject({ status: "signed", typedName: "IT Signer", replayed: true });
    expect(await effects()).toEqual(committed);
    expect(await listed()).toEqual([signature!.signature_path]);

    const signed = await read();
    expect(signed.view).toMatchObject({ contract: { status: "signed" }, signing: { signed: true, typed_name: "IT Signer" } });
    expect(signed.summary).toMatchObject({ terms_status: "signed", booking_status: "awaiting_deposit" });
    expect(signed.staffSummary.booking).toMatchObject({ lifecycle_status: "awaiting_deposit", policy: "on_deposit", legacy_signed: false });

    // A real sign_contract replay parses too.
    const { data: replay } = await must(admin.rpc("sign_contract", {
      p_contract_id: contractId, p_tenant_slug: catalog.slug, p_user_id: client.id, p_typed_name: "IT Signer", p_content_sha256: input.contentSha256,
      p_consent_version: "demo-v1", p_consent_accepted: true, p_signature_path: signature!.signature_path, p_signature_sha256: "0".repeat(64),
      p_signature_bytes: 1, p_signature_width: 1, p_signature_height: 1, p_user_agent: "", p_client_ip: "", p_client_ip_source: "unavailable",
    }));
    expect(signContractResultSchema.parse(replay)).toMatchObject({ status: "signed", replayed: true, contract_id: contractId });

    // Payments: the deposit books the event, and every summary still parses.
    await must(staff.rpc("record_event_payment", {
      p_event_id: eventId, p_amount_cents: 121_587, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
    }));
    const booked = await read();
    expect(booked.summary).toMatchObject({ booking_status: "booked", received_cents: 121_587, deposit_outstanding_cents: 0 });
    expect(booked.staffSummary.booking.booking_confirmed_at).not.toBeNull();
    const { data: approved } = await must(client.db.rpc("client_approved_offer", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(approvedOfferSchema.parse(approved)).toMatchObject({ contract: { status: "signed" } });
  }, 120_000);

  it("an undiscounted contract has no frozen breakdown, and a rejection parses", async () => {
    const { contractId, client } = await sentContract(null);
    const { data: summary } = await must(client.db.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(clientPaymentSummarySchema.parse(summary).pricing).toBeUndefined();
    const { data: rejected } = await must(admin.rpc("sign_contract", {
      p_contract_id: contractId, p_tenant_slug: catalog.slug, p_user_id: client.id, p_typed_name: "IT Signer", p_content_sha256: "0".repeat(64),
      p_consent_version: "demo-v1", p_consent_accepted: true, p_signature_path: "", p_signature_sha256: "", p_signature_bytes: 0,
      p_signature_width: 0, p_signature_height: 0, p_user_agent: "", p_client_ip: "", p_client_ip_source: "unavailable",
    }));
    expect(signContractResultSchema.parse(rejected)).toMatchObject({ status: "rejected", code: "content_changed" });
    // Another account sees the contract as unavailable, which parses as such.
    const stranger = await signedInUser(admin, `it-shapes-stranger-${run}@example.test`);
    const { data: hidden } = await must(stranger.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(clientContractViewSchema.parse(hidden)).toEqual({ state: "unavailable" });
  }, 120_000);
});
