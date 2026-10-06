/**
 * A real booking for planning specs, through the same database functions the
 * app calls (their screens are covered by the proposal, contract and payment
 * specs): proposal sent, submitted and approved; contract generated, sent,
 * accepted and signed by the client; deposit recorded.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin, status } from "./support";
import { publishContractTemplate, submitAsClient, type TestTenant } from "./tenant";

// A 1x1 PNG: the signing function checks the stored object's type and size.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

/** A real Auth session for an existing user, from a magic-link token (no email, no rate limit). */
export async function sessionFor(email: string): Promise<SupabaseClient> {
  const { data } = await must(admin.auth.admin.generateLink({ type: "magiclink", email }));
  const db = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(db.auth.verifyOtp({ token_hash: data.properties!.hashed_token, type: "magiclink" }));
  return db;
}

/** Books `eventId` for a new client account `clientEmail` (the event's primary contact). Returns the contract id. */
export async function bookEvent(tenant: TestTenant, eventId: string, clientEmail: string): Promise<string> {
  const staffDb = await sessionFor(tenant.ownerEmail);
  const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
  const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
  const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input }));
  const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
  await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: randomUUID().replaceAll("-", "").repeat(2) }));
  await submitAsClient(tenant, proposalId as string);
  const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).not("submitted_at", "is", null).single());
  const { data: approval } = await must(staffDb.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));
  const versionId = await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
    { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
  ]);
  const { data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));

  const { data: user } = await must(admin.auth.admin.createUser({ email: clientEmail, email_confirm: true }));
  const clientDb = await sessionFor(clientEmail);
  await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
  const { data: c } = await must(admin.from("contracts").select("content_sha256, consent_version, deposit_cents").eq("id", contractId).single());
  const path = `${tenant.id}/${contractId}/${randomUUID()}.png`;
  await must(admin.storage.from("contract-signatures").upload(path, PNG, { contentType: "image/png" }));
  const { data: signed } = await must(admin.rpc("sign_contract", {
    p_contract_id: contractId, p_tenant_slug: tenant.slug, p_user_id: user.user!.id, p_typed_name: "Jordan Lee",
    p_content_sha256: c!.content_sha256, p_consent_version: c!.consent_version, p_consent_accepted: true, p_signature_path: path,
    p_signature_sha256: createHash("sha256").update(PNG).digest("hex"), p_signature_bytes: PNG.length, p_signature_width: 1, p_signature_height: 1,
    p_user_agent: "E2E", p_client_ip: null, p_client_ip_source: "unavailable",
  }));
  expect((signed as { status: string }).status).toBe("signed");
  // No PDF needed here; retire the job so later signing specs never wait behind it.
  const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
  for (const j of (jobs ?? []) as { job_id: string; lease_token: string }[]) {
    await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "planning e2e: PDF not needed", p_permanent: true });
  }
  const { data: paid } = await must(staffDb.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: c!.deposit_cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    p_reference: "E2E-PAYMENT-REF-SECRET", p_note: "E2E staff payment note", p_idempotency_key: randomUUID(), p_confirm_duplicate: false,
  }));
  expect((paid as { booking: string }).booking).toBe("booked");
  return contractId;
}

/** Everything planning must never change: the contract, its proposal, payments and the booking. */
export async function contractualState(eventId: string): Promise<string> {
  const { data: event } = await admin.from("events").select("booking_confirmed_at, lifecycle_status, contracts(id, status, content_sha256, signed_at, total_cents, proposal_id)").eq("id", eventId).single();
  const { data: payments } = await admin.from("event_payments").select("id, amount_cents, invalidated_at").eq("event_id", eventId).order("id");
  const contracts = (event as unknown as { contracts: { proposal_id: string }[] }).contracts;
  const { data: proposals } = await admin.from("proposals").select("id, status, offer_sha256").in("id", contracts.map((c) => c.proposal_id));
  return JSON.stringify({ event, payments, proposals });
}
