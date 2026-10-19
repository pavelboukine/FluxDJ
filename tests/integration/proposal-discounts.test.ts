/**
 * Proposal discounts against the LOCAL stack, through the real pricing module
 * and the real database checks: the browser's price (lib/pricing) and the
 * database's verification agree for percentages, fixed amounts, several lines
 * and 100% off; the approved discounted total becomes the contract's total,
 * deposit and balance, recorded payments are measured against it, booking
 * still needs the signature and deposit, and the emails carry the same
 * figures. Dedicated it- tenant, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import type { OfferSnapshot } from "@/lib/pricing";
import { minimumSelectionSubtotal, parseOfferSnapshot, priceSelection } from "@/lib/pricing";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import type { Json } from "@/lib/supabase/database.types";
import { adminClient, archiveTestTenants, bothSeparate, clientView, createEvent, createTenantWithCatalog, must, openLink, sendDraft, signedInUser, submit, type Catalog, type Db } from "./support/fixtures";

const SECTIONS = [
  { heading: "Price", body: "Before discount {{pricing.subtotal_before_discount}}. {{pricing.discount}} Subtotal {{pricing.subtotal}}. Total {{pricing.total}}." },
  { heading: "Payment", body: "Deposit ({{payment.deposit_percent}}): {{payment.deposit}}. Balance {{payment.balance}}." },
];
const run = randomUUID().slice(0, 8);
let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;
let minCatalog: Catalog;

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

/** A sent proposal with `discount`, opened by its client. */
async function discounted(discount: Record<string, unknown> | null, clientEmail = `it-disc-${randomUUID().slice(0, 8)}@example.test`) {
  const { eventId } = await createEvent(admin, catalog, clientEmail);
  const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
  const offer = { ...(input as Record<string, Json>), ...(discount ? { discount: discount as Json } : {}) };
  const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: offer }));
  const { token } = await sendDraft(staff, proposalId as string);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  return { eventId, proposalId: proposalId as string, sessionHash, clientEmail };
}

beforeAll(async () => {
  admin = adminClient();
  const owner = await signedInUser(admin, `it-disc-owner-${run}@example.test`);
  staff = owner.db;
  catalog = await createTenantWithCatalog(admin, owner.id, "it-disc");
  await must(admin.from("tenants").update({ business_address: "1 Rue IT", reply_to_email: "hello@it-disc.example.test" }).eq("id", catalog.tenantId));
  const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT discount", p_title: "DEMO, NOT FOR CLIENT USE: Booking", p_sections: SECTIONS }));
  const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  versionId = version!.id;
  await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
});

afterAll(async () => {
  if (admin) await archiveTestTenants(admin, catalog?.tenantId, minCatalog?.tenantId);
});

describe("proposal discounts (local Supabase)", () => {
  it("the browser's price and the database's check agree for every kind of discount", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ type: "percent", percent_basis_points: 1000, label: "Wedding Special" }, { package_key: "signature", answers: bothSeparate }],
      [{ type: "percent", percent_basis_points: 3333, label: null }, { package_key: "premium", answers: bothSeparate, addons: { uplights_4: 3 } }],
      [{ type: "percent", percent_basis_points: 1250, label: "Spring" }, { package_key: "essential", answers: bothSeparate, addons: { uplights_4: 1, additional_location_speaker: 3 } }],
      [{ type: "fixed", amount_cents: 12_345, label: "Returning Client Discount" }, { package_key: "essential", answers: { ...bothSeparate, speeches_wireless_mic: true } }],
      [{ type: "fixed", amount_cents: 150_000, label: "Friends & Family" }, { package_key: "essential", answers: bothSeparate }],
      [{ type: "percent", percent_basis_points: 10_000, label: "Courtesy Discount" }, { package_key: "signature", answers: bothSeparate, addons: { uplights_4: 2 } }],
    ];
    for (const [discount, input] of cases) {
      const p = await discounted(discount);
      const view = await clientView(admin, catalog.slug, p.proposalId, p.sessionHash);
      const priced = priceSelection(view.offer as OfferSnapshot, input);
      expect(priced.ok).toBe(true);
      const result = await submit(admin, { slug: catalog.slug, proposalId: p.proposalId, sessionHash: p.sessionHash, draftVersion: 0, input });
      expect(result, JSON.stringify(discount)).toMatchObject({ status: "submitted" });
      const { data: row } = await must(admin.from("proposal_selections").select("subtotal_cents, discount_cents, tax_cents, total_cents").eq("id", result.selection_id as string).single());
      const s = priced.ok ? priced.selection : null;
      expect(row).toEqual({ subtotal_cents: s!.subtotal_cents, discount_cents: s!.discount_cents, tax_cents: s!.tax_cents, total_cents: s!.total_cents });
      expect(row!.discount_cents).toBeGreaterThan(0);
    }
  }, 120_000);

  it("an undiscounted proposal is priced, stored and checked exactly as before", async () => {
    const p = await discounted(null);
    const input = { package_key: "signature", answers: bothSeparate };
    const result = await submit(admin, { slug: catalog.slug, proposalId: p.proposalId, sessionHash: p.sessionHash, draftVersion: 0, input });
    expect(result).toMatchObject({ status: "submitted" });
    const { data: row } = await must(admin.from("proposal_selections").select("subtotal_cents, discount_cents, total_cents, selection_snapshot").eq("id", result.selection_id as string).single());
    expect(row).toMatchObject({ subtotal_cents: 235_000, discount_cents: 0, total_cents: 270_191 });
    expect(row!.selection_snapshot).not.toHaveProperty("discount");
  });

  it("100% off makes a contract with nothing to pay, and signing books it", async () => {
    const clientEmail = `it-disc-free-${run}@example.test`;
    const p = await discounted({ type: "percent", percent_basis_points: 10_000, label: "Courtesy Discount" }, clientEmail);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId: p.proposalId, sessionHash: p.sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: p.proposalId, p_selection_id: submitted.selection_id as string }));
    const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const { data: contract } = await must(admin.from("contracts").select("total_cents, deposit_cents, balance_cents, content_sha256").eq("id", contractId).single());
    expect(contract).toMatchObject({ total_cents: 0, deposit_cents: 0, balance_cents: 0 });
    const linkId = randomUUID();
    await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
    const client = await signedInUser(admin, clientEmail);
    await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
    expect(await signContractAs({
      userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: contract!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    })).toMatchObject({ status: "signed" });
    const { data: summary } = await must(staff.rpc("event_payment_summary", { p_event_id: p.eventId }));
    expect(summary).toMatchObject({ terms: { total_cents: 0, deposit_cents: 0 }, remaining_balance_cents: 0 });
    expect((await must(admin.from("events").select("lifecycle_status").eq("id", p.eventId).single())).data!.lifecycle_status).toBe("booked");
  }, 120_000);

  it("the approved discounted total is the contract's total, deposit and balance; payments, booking and emails follow it", async () => {
    const clientEmail = `it-disc-flow-${run}@example.test`;
    const p = await discounted({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" }, clientEmail);
    const submitted = await submit(admin, { slug: catalog.slug, proposalId: p.proposalId, sessionHash: p.sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
    // 235,000 - 23,500 = 211,500 taxed: GST 10,575, QST 21,098.
    const { data: selection } = await must(admin.from("proposal_selections").select("total_cents, discount_cents").eq("id", submitted.selection_id as string).single());
    expect(selection).toEqual({ total_cents: 243_173, discount_cents: 23_500 });
    const { data: teamEmail } = await must(admin.from("email_outbox").select("payload").eq("event_type", "proposal_submitted").eq("entity_id", p.proposalId).single());
    expect((teamEmail!.payload as { total_cents: number }).total_cents).toBe(243_173);

    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: p.proposalId, p_selection_id: submitted.selection_id as string }));
    const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const { data: contract } = await must(admin.from("contracts").select("total_cents, deposit_cents, balance_cents, rendered_content, content_sha256").eq("id", contractId).single());
    expect(contract).toMatchObject({ total_cents: 243_173, deposit_cents: 121_587, balance_cents: 121_586 });
    const body = (contract!.rendered_content as { sections: { body: string }[] }).sections.map((s) => s.body).join("\n");
    expect(body).toBe(
      "Before discount 2,350.00 CAD. Wedding Special (10%): -235.00 CAD Subtotal 2,115.00 CAD. Total 2,431.73 CAD.\nDeposit (50%): 1,215.87 CAD. Balance 1,215.86 CAD.",
    );

    const linkId = randomUUID();
    await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
    const { data: contractEmail } = await must(admin.from("email_outbox").select("payload").eq("event_type", "contract_sent").eq("entity_id", contractId).single());
    expect(JSON.stringify(contractEmail!.payload)).not.toContain("270191");
    const client = await signedInUser(admin, clientEmail);
    await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
    expect(await signContractAs({
      userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: contract!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    })).toMatchObject({ status: "signed" });

    // A payment short of the discounted deposit doesn't book; the deposit does, and the balance is what remains.
    const pay = (cents: number) => staff.rpc("record_event_payment", {
      p_event_id: p.eventId, p_amount_cents: cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      p_reference: "", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: true,
    });
    expect((await must(pay(100_000))).data).toMatchObject({ status: "recorded" });
    expect((await must(admin.from("events").select("lifecycle_status").eq("id", p.eventId).single())).data!.lifecycle_status).toBe("awaiting_deposit");
    await must(pay(21_587));
    expect((await must(admin.from("events").select("lifecycle_status").eq("id", p.eventId).single())).data!.lifecycle_status).toBe("booked");
    const { data: summary } = await must(staff.rpc("event_payment_summary", { p_event_id: p.eventId }));
    expect(summary).toMatchObject({ terms: { total_cents: 243_173, deposit_cents: 121_587 }, received_cents: 121_587, deposit_outstanding_cents: 0, remaining_balance_cents: 121_586 });
    const { data: booking } = await must(admin.from("email_outbox").select("payload").eq("event_type", "booking_confirmed").eq("entity_id", contractId).single());
    expect(booking!.payload).toMatchObject({ total_cents: 243_173, remaining_cents: 121_586 });
    const { count } = await must(admin.from("event_payments").select("id", { count: "exact", head: true }).eq("event_id", p.eventId));
    expect(count).toBe(2);

    // The client's payment summary carries the contract's frozen breakdown.
    const { data: clientSummary } = await must(client.db.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: catalog.slug }));
    expect(clientSummary).toMatchObject({
      total_cents: 243_173, deposit_cents: 121_587, remaining_balance_cents: 121_586,
      pricing: {
        subtotal_cents: 235_000, discounted_subtotal_cents: 211_500, total_cents: 243_173,
        discount: { type: "percent", label: "Wedding Special", percent_basis_points: 1000, amount_cents: 23_500 },
        tax_breakdown: [{ label: "GST", rate_ppm: 50_000, amount_cents: 10_575 }, { label: "QST", rate_ppm: 99_750, amount_cents: 21_098 }],
      },
    });
  }, 120_000);
});

describe("the fixed discount limit and a fully discounted booking (local Supabase)", () => {
  it("allows up to the lowest possible subtotal, with required gear and custom prices, the same in the browser and the database", async () => {
    const owner = await signedInUser(admin, `it-disc-min-owner-${run}@example.test`);
    const minStaff = owner.db;
    minCatalog = await createTenantWithCatalog(admin, owner.id, "it-disc-min");
    // Every cocktail answer now needs gear: uplights in the same room, a speaker in a separate space.
    const { data: cocktail } = await must(admin.from("logistics_questions").select("id").eq("tenant_id", minCatalog.tenantId).eq("key", "cocktail_location").single());
    await must(admin.from("logistics_rules").insert({ tenant_id: minCatalog.tenantId, question_id: cocktail!.id, condition: { op: "equals", value: "same_room" }, gear_item_id: minCatalog.gear.uplights, required_quantity: 1, reason: "Same-room cocktails need uplights." }));
    await must(admin.from("tenants").update({ business_address: "1 Rue IT", contact_email: "it-min@example.test" }).eq("id", minCatalog.tenantId));

    const clientEmail = `it-disc-min-client-${run}@example.test`;
    const { eventId } = await createEvent(admin, minCatalog, clientEmail);
    const { data: input } = await must(minStaff.rpc("proposal_offer_input_from_template", { p_template_id: minCatalog.templateId }));
    const base = { ...(input as Record<string, Json>), price_overrides: [{ gear_item_id: minCatalog.gear.uplights, unit_price_cents: 10_000 }] };
    const { data: proposalId } = await must(minStaff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: base }));
    const preview = (discount?: Record<string, unknown>) =>
      minStaff.rpc("preview_proposal_draft", { p_proposal_id: proposalId as string, p_offer: { ...base, ...(discount ? { discount: discount as Json } : {}) } });

    // Essential (1,500.00) plus same-room uplights at this proposal's price (100.00); optional add-ons don't count.
    const plain = parseOfferSnapshot((await must(preview())).data);
    expect(minimumSelectionSubtotal(plain)).toBe(160_000);
    expect((await must(preview({ type: "fixed", amount_cents: 160_000, label: "Courtesy" }))).data).toMatchObject({ discount: { type: "fixed", amount_cents: 160_000 } });
    const over = await preview({ type: "fixed", amount_cents: 160_001, label: "Courtesy" });
    expect(over.error?.message).toContain("can't be more than the lowest possible subtotal of this proposal (1,600.00 CAD)");

    // Fully discounted: the cheapest complete selection costs nothing; the contract books on signing with no payment.
    const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId as string).single());
    await must(minStaff.rpc("update_proposal_draft", { p_proposal_id: proposalId as string, p_expected_version: draft!.draft_version, p_offer: { ...base, discount: { type: "fixed", amount_cents: 160_000, label: "Courtesy" } } }));
    const { token } = await sendDraft(minStaff, proposalId as string);
    const { sessionHash } = await openLink(admin, minCatalog.slug, token);
    const answers = { ceremony_location: "same_room", cocktail_location: "same_room", speeches_wireless_mic: false };
    const submitted = await submit(admin, { slug: minCatalog.slug, proposalId: proposalId as string, sessionHash, draftVersion: 0, input: { package_key: "essential", answers } });
    expect(submitted).toMatchObject({ status: "submitted" });
    const { data: selection } = await must(admin.from("proposal_selections").select("subtotal_cents, discount_cents, tax_cents, total_cents").eq("id", submitted.selection_id as string).single());
    expect(selection).toEqual({ subtotal_cents: 160_000, discount_cents: 160_000, tax_cents: 0, total_cents: 0 });

    const { data: templateId } = await must(minStaff.rpc("create_contract_template", { p_tenant_id: minCatalog.tenantId, p_name: "IT min", p_title: "DEMO, NOT FOR CLIENT USE: Booking", p_sections: SECTIONS }));
    const { data: version } = await must(minStaff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    await must(minStaff.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "demo" }));
    const { data: approval } = await must(minStaff.rpc("approve_proposal_selection", { p_proposal_id: proposalId as string, p_selection_id: submitted.selection_id as string }));
    const { data: generated } = await must(minStaff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: version!.id }));
    const contractId = (generated as { contract_id: string }).contract_id;
    const { data: contract } = await must(admin.from("contracts").select("total_cents, deposit_cents, balance_cents, content_sha256, rendered_content").eq("id", contractId).single());
    expect(contract).toMatchObject({ total_cents: 0, deposit_cents: 0, balance_cents: 0 });
    expect(JSON.stringify(contract!.rendered_content)).toContain("Courtesy: -1,600.00 CAD Subtotal 0.00 CAD. Total 0.00 CAD.");
    const linkId = randomUUID();
    await must(minStaff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
    const client = await signedInUser(admin, clientEmail);
    await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: minCatalog.slug }));
    expect(await signContractAs({
      userDb: client.db, userId: client.id, admin, slug: minCatalog.slug, contractId,
      input: { typedName: "IT Signer", consentAccepted: true, consentVersion: "demo-v1", contentSha256: contract!.content_sha256, signature: signaturePng() },
      request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
    })).toMatchObject({ status: "signed" });

    const { data: event } = await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single());
    expect(event!.lifecycle_status).toBe("booked");
    expect(event!.booking_confirmed_at).not.toBeNull();
    const { count: payments } = await must(admin.from("event_payments").select("id", { count: "exact", head: true }).eq("event_id", eventId));
    expect(payments).toBe(0);
    const { data: booking } = await must(admin.from("email_outbox").select("payload").eq("event_type", "booking_confirmed").eq("entity_id", contractId).single());
    expect(booking!.payload).toMatchObject({ total_cents: 0, remaining_cents: 0 });
    const { data: summary } = await must(client.db.rpc("client_payment_summary", { p_contract_id: contractId, p_tenant_slug: minCatalog.slug }));
    expect(summary).toMatchObject({ booking_status: "booked", total_cents: 0, deposit_cents: 0, remaining_balance_cents: 0, received_cents: 0, pricing: { discounted_subtotal_cents: 0, total_cents: 0 } });
    // Booked for planning: booking set planning up with Event basics, so the client sees it being set up
    // (an unbooked event would be "unavailable"), exactly as for any booking.
    const { data: view } = await must(client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: minCatalog.slug }));
    expect((view as { state: string }).state).toBe("setting_up");
  }, 180_000);
});
