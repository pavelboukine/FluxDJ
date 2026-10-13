/**
 * Proposal-specific prices and paired gear against the LOCAL Supabase stack,
 * through PostgREST with real sessions: a custom price is frozen when sent,
 * the client's selection and the database verification use it (with
 * quantities above one and exact taxes), the approved terms and the
 * generated contract (deposit, balance) match, the catalog price never
 * changes, and a revision starts with the same prices. Pieces per unit only
 * change wording, never money.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_TEMPLATE_SECTIONS, DEMO_TEMPLATE_TITLE } from "@/lib/contracts/demo-template";
import { quantityText } from "@/lib/catalog/quantity";
import { renderedContentSchema } from "@/lib/contracts/content";
import { parseOfferSnapshot, priceSelection, toSelectionRecord } from "@/lib/pricing";
import type { Json } from "@/lib/supabase/database.types";
import {
  adminClient,
  archiveTestTenants,
  bothSeparate,
  clientView,
  createEvent,
  createTenantWithCatalog,
  must,
  openLink,
  sendDraft,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";
import { sql } from "./support/sql";
import { QUANTITY_CASES } from "../support/quantity-cases";

let admin: Db;
let staff: Db;
let otherStaff: Db;
let catalog: Catalog;
let otherCatalog: Catalog;

const UPLIGHTS_CUSTOM = 10_000; // catalog 12,000
const SPEAKER_CUSTOM = 13_250; // catalog 15,000; charged when answers require it

async function publishDemo(db: Db, tenantId: string) {
  const { data: templateId } = await must(db.rpc("create_contract_template", { p_tenant_id: tenantId, p_name: `IT DEMO ${randomUUID().slice(0, 6)}`, p_title: DEMO_TEMPLATE_TITLE, p_sections: DEMO_TEMPLATE_SECTIONS }));
  const { data: version } = await must(db.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  await must(db.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "demo" }));
  return version!.id;
}

/** The template's offer with this proposal's prices, as the builder saves it. */
async function customOffer() {
  const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
  return {
    ...(input as Record<string, Json>),
    price_overrides: [
      { gear_item_id: catalog.gear.uplights, unit_price_cents: UPLIGHTS_CUSTOM },
      { gear_item_id: catalog.gear.speaker, unit_price_cents: SPEAKER_CUSTOM },
    ],
  };
}

describe("proposal-specific prices (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-custom-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-custom");
    const other = await signedInUser(admin, `it-custom-other-${randomUUID().slice(0, 8)}@example.test`);
    otherStaff = other.db;
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-custom-b");
    // Uplights sold as a set of four lights, in a Lighting category.
    const { data: category } = await must(staff.from("gear_categories").insert({ tenant_id: catalog.tenantId, name: "Lighting", sort_order: 20 }).select("id").single());
    await must(staff.from("gear_items").update({ category_id: category!.id, unit_label: "set", pieces_per_unit: 4, piece_label: "lights" }).eq("id", catalog.gear.uplights));
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherCatalog?.tenantId);
  });

  it("previews unsaved prices without saving them, for the business's own staff only", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-custom-preview-${randomUUID().slice(0, 6)}@example.test`);
    const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    const { data: before } = await must(staff.from("proposals").select("draft_version, draft_offer").eq("id", proposalId!).single());

    const { data: snapshot } = await must(staff.rpc("preview_proposal_draft", { p_proposal_id: proposalId!, p_offer: await customOffer() }));
    const offer = parseOfferSnapshot(snapshot);
    expect(offer.gear.uplights_4).toMatchObject({ unit_price_cents: UPLIGHTS_CUSTOM, unit_label: "set", pieces_per_unit: 4, piece_label: "lights", category: { name: "Lighting", sort_order: 20 } });
    expect(offer.gear.additional_location_speaker.unit_price_cents).toBe(SPEAKER_CUSTOM);
    const { data: after } = await must(staff.from("proposals").select("draft_version, draft_offer").eq("id", proposalId!).single());
    expect(after).toEqual(before);

    const { error } = await otherStaff.rpc("preview_proposal_draft", { p_proposal_id: proposalId!, p_offer: await customOffer() });
    expect(error?.message).toBe("not found");
  });

  it("freezes the custom prices, verifies the client's selection against them and carries them into the contract", async () => {
    const versionId = await publishDemo(staff, catalog.tenantId);
    const email = `it-custom-client-${randomUUID().slice(0, 6)}@example.test`;
    const { eventId, clientId } = await createEvent(admin, catalog, email);
    const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: await customOffer() }));
    const { token } = await sendDraft(staff, proposalId!);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const view = await clientView(admin, catalog.slug, proposalId!, sessionHash);
    expect(view.offer!.gear.uplights_4.unit_price_cents).toBe(UPLIGHTS_CUSTOM);

    // Two sets of uplights (quantity above one) and two separate spaces: one speaker beyond the package's.
    const input = { package_key: "signature", addons: { uplights_4: 2 }, answers: bothSeparate };
    const priced = priceSelection(view.offer!, input);
    if (!priced.ok) throw new Error("did not price");
    const s = priced.selection;
    const charged = s.lines.filter((l) => l.source === "optional" || l.source === "required").map((l) => [l.item_key, l.quantity, l.unit_price_cents, l.line_total_cents]);
    expect(charged).toEqual([
      ["uplights_4", 2, UPLIGHTS_CUSTOM, 2 * UPLIGHTS_CUSTOM],
      ["additional_location_speaker", 1, SPEAKER_CUSTOM, SPEAKER_CUSTOM],
    ]);
    // Exact cents: 220,000 + 20,000 + 13,250; taxes rounded per line and tax, half up.
    expect(s.subtotal_cents).toBe(253_250);
    const gst = 11_000 + 1_000 + 663; // 662.5 rounds up
    const qst = 21_945 + 1_995 + 1_322; // 21945, 1995, 1321.69 -> 1322
    expect(s.tax_breakdown.map((t) => t.amount_cents)).toEqual([gst, qst]);
    expect(s.total_cents).toBe(253_250 + gst + qst);

    // A client can't pay the catalog price instead (or any other amount): only the frozen price passes.
    const tampered = JSON.parse(JSON.stringify(toSelectionRecord(s, view.proposal!.offer_sha256)));
    const line = tampered.lines.find((l: { item_key: string }) => l.item_key === "uplights_4");
    line.unit_price_cents = 12_000;
    line.line_total_cents = 24_000;
    const { data: refused } = await must(
      admin.rpc("client_submit_selection", {
        p_session_hash: sessionHash, p_proposal_id: proposalId!, p_tenant_slug: catalog.slug, p_expected_draft_version: 0,
        p_idempotency_key: randomUUID().replaceAll("-", ""), p_selection: tampered,
      }),
    );
    expect((refused as { status: string; message?: string }).message).toMatch(/does not match the frozen offer|subtotal does not equal/);

    const submitted = await submit(admin, { slug: catalog.slug, proposalId: proposalId!, sessionHash, draftVersion: 0, input });
    expect(submitted.status).toBe("submitted");
    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId!, p_selection_id: submitted.selection_id as string }));
    const { data: stored } = await must(admin.from("proposal_selections").select("subtotal_cents, tax_cents, total_cents").eq("id", submitted.selection_id as string).single());
    expect(stored).toEqual({ subtotal_cents: s.subtotal_cents, tax_cents: s.tax_cents, total_cents: s.total_cents });

    await must(admin.from("clients").update({ phone: "+1 438 555 0101" }).eq("id", clientId));
    await must(admin.from("events").update({ venue_name: "IT Hall", venue_address: "9 Test St" }).eq("id", eventId));
    const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const { data: generated } = await must(
      staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId, p_balance_due_date: due }),
    );
    const { data: contract } = await must(staff.from("contracts").select("total_cents, deposit_cents, balance_cents, commercial_snapshot").eq("id", (generated as { contract_id: string }).contract_id).single());
    const deposit = Number((BigInt(s.total_cents) * BigInt(5000) + BigInt(5000)) / BigInt(10000));
    expect(contract).toMatchObject({ total_cents: s.total_cents, deposit_cents: deposit, balance_cents: s.total_cents - deposit });
    expect(contract!.commercial_snapshot).toMatchObject({ subtotal_cents: s.subtotal_cents, tax_breakdown: s.tax_breakdown });

    // The catalog prices never changed.
    const { data: gear } = await must(admin.from("gear_items").select("id, default_price_cents").in("id", [catalog.gear.uplights, catalog.gear.speaker]));
    expect(Object.fromEntries(gear!.map((g) => [g.id, g.default_price_cents]))).toEqual({ [catalog.gear.uplights]: 12_000, [catalog.gear.speaker]: 15_000 });
  });

  it("a revision starts with the same custom prices; resetting one there leaves the sent offer alone", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-custom-rev-${randomUUID().slice(0, 6)}@example.test`);
    const { data: first } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: await customOffer() }));
    await sendDraft(staff, first!);
    const { data: sentBefore } = await must(admin.from("proposals").select("offer_snapshot").eq("id", first!).single());

    const { data: revision } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    expect(revision).not.toBe(first);
    const { data: draft } = await must(staff.from("proposals").select("draft_offer, draft_version").eq("id", revision!).single());
    const offer = draft!.draft_offer as { price_overrides?: unknown };
    expect(offer.price_overrides).toEqual((await customOffer()).price_overrides);

    // Reset the uplights to the standard price in the revision.
    const next = { ...(draft!.draft_offer as Record<string, Json>), price_overrides: [{ gear_item_id: catalog.gear.speaker, unit_price_cents: SPEAKER_CUSTOM }] };
    await must(staff.rpc("update_proposal_draft", { p_proposal_id: revision!, p_expected_version: draft!.draft_version, p_offer: next }));
    const { data: preview } = await must(staff.rpc("preview_proposal_offer", { p_proposal_id: revision! }));
    expect(parseOfferSnapshot(preview).gear.uplights_4.unit_price_cents).toBe(12_000);
    const { data: sentAfter } = await must(admin.from("proposals").select("offer_snapshot").eq("id", first!).single());
    expect(sentAfter).toEqual(sentBefore);
  });

  it("refuses malformed custom prices and categories from another business", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-custom-bad-${randomUUID().slice(0, 6)}@example.test`);
    const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    const bad = { ...(await customOffer()), price_overrides: [{ gear_item_id: catalog.gear.uplights, unit_price_cents: 99.5 }] };
    const { error } = await staff.rpc("update_proposal_draft", { p_proposal_id: proposalId!, p_expected_version: 0, p_offer: bad });
    expect(error?.message).toContain("invalid shape");

    const { data: foreign } = await must(otherStaff.from("gear_categories").insert({ tenant_id: otherCatalog.tenantId, name: "Audio" }).select("id").single());
    const { error: cross } = await staff.from("gear_items").update({ category_id: foreign!.id }).eq("id", catalog.gear.mic);
    expect(cross?.code).toBe("23503");
    const { data: seen } = await must(staff.from("gear_categories").select("name"));
    expect(seen!.map((c) => c.name)).toEqual(["Lighting"]);
  });

  it("contracts word quantities exactly as proposals do: the database formatter passes the shared cases", () => {
    for (const c of QUANTITY_CASES) {
      const gear = JSON.stringify(c.gear).replaceAll("$", "");
      const name = c.gear.name.replaceAll("$", "");
      const fromDb = sql(`select private.gear_quantity_text($g$${gear}$g$::jsonb, $n$${name}$n$, ${c.quantity});`);
      expect(fromDb, c.label).toBe(c.expected);
      expect(quantityText(c.gear, c.quantity), c.label).toBe(fromDb);
    }
  });

  it("package base prices for one proposal: frozen, verified, approved and carried into the contract with matching wording", async () => {
    const versionId = await publishDemo(staff, catalog.tenantId);
    const { eventId, clientId } = await createEvent(admin, catalog, `it-custom-pkg-${randomUUID().slice(0, 6)}@example.test`);
    const offer = {
      ...(await customOffer()),
      price_overrides: [
        { package_id: catalog.pkg.essential, unit_price_cents: 140_000 },
        { package_id: catalog.pkg.signature, unit_price_cents: 200_000 },
        { package_id: catalog.pkg.premium, unit_price_cents: 285_000 },
        { gear_item_id: catalog.gear.uplights, unit_price_cents: UPLIGHTS_CUSTOM },
      ],
    };
    const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    // An unsaved package price shows in the preview without touching the draft.
    const { data: before } = await must(staff.from("proposals").select("draft_version, draft_offer").eq("id", proposalId!).single());
    const { data: unsaved } = await must(staff.rpc("preview_proposal_draft", { p_proposal_id: proposalId!, p_offer: offer }));
    expect(parseOfferSnapshot(unsaved).packages.map((p) => [p.key, p.base_price_cents])).toEqual([["essential", 140_000], ["signature", 200_000], ["premium", 285_000]]);
    expect((await must(staff.from("proposals").select("draft_version, draft_offer").eq("id", proposalId!).single())).data).toEqual(before);

    await must(staff.rpc("update_proposal_draft", { p_proposal_id: proposalId!, p_expected_version: before!.draft_version, p_offer: offer }));
    // A stale save (another tab) is still refused.
    const { error: stale } = await staff.rpc("update_proposal_draft", { p_proposal_id: proposalId!, p_expected_version: before!.draft_version, p_offer: offer });
    expect(stale?.code).toBe("PT409");

    const { token } = await sendDraft(staff, proposalId!);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const view = await clientView(admin, catalog.slug, proposalId!, sessionHash);
    const input = { package_key: "signature", addons: { uplights_4: 1 }, answers: { ...bothSeparate, ceremony_location: "same_room", cocktail_location: "same_room" } };
    const priced = priceSelection(view.offer!, input);
    if (!priced.ok) throw new Error("did not price");
    const s = priced.selection;
    expect(s.lines.find((l) => l.source === "package")).toMatchObject({ item_key: "signature", unit_price_cents: 200_000, line_total_cents: 200_000 });
    expect(s.subtotal_cents).toBe(210_000);
    const gst = 10_000 + 500;
    const qst = 19_950 + 998; // 997.5 rounds up
    expect([s.tax_cents, s.total_cents]).toEqual([gst + qst, 210_000 + gst + qst]);

    // The catalog package price can't be slipped in by the client.
    const tampered = JSON.parse(JSON.stringify(toSelectionRecord(s, view.proposal!.offer_sha256)));
    const pkgLine = tampered.lines.find((l: { source: string }) => l.source === "package");
    pkgLine.unit_price_cents = 220_000;
    pkgLine.line_total_cents = 220_000;
    const { data: refused } = await must(
      admin.rpc("client_submit_selection", {
        p_session_hash: sessionHash, p_proposal_id: proposalId!, p_tenant_slug: catalog.slug, p_expected_draft_version: 0,
        p_idempotency_key: randomUUID().replaceAll("-", ""), p_selection: tampered,
      }),
    );
    expect((refused as { message?: string }).message).toMatch(/does not match the frozen offer|subtotal does not equal/);

    const submitted = await submit(admin, { slug: catalog.slug, proposalId: proposalId!, sessionHash, draftVersion: 0, input });
    expect(submitted.status).toBe("submitted");
    const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId!, p_selection_id: submitted.selection_id as string }));

    // The catalog changes after approval; the contract still uses the approved terms.
    await must(admin.from("gear_items").update({ unit_label: "pair", pieces_per_unit: 2, piece_label: "cans", name: "Renamed" }).eq("id", catalog.gear.uplights));
    await must(admin.from("packages").update({ base_price_cents: 999_900 }).eq("id", catalog.pkg.signature));
    await must(admin.from("clients").update({ phone: "+1 438 555 0101" }).eq("id", clientId));
    await must(admin.from("events").update({ venue_name: "IT Hall", venue_address: "9 Test St" }).eq("id", eventId));
    const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const { data: generated } = await must(
      staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId, p_balance_due_date: due }),
    );
    const { data: contract } = await must(staff.from("contracts").select("*").eq("id", (generated as { contract_id: string }).contract_id).single());
    const deposit = Number((BigInt(s.total_cents) * BigInt(5000) + BigInt(5000)) / BigInt(10000));
    expect(contract).toMatchObject({ total_cents: s.total_cents, deposit_cents: deposit, balance_cents: s.total_cents - deposit });
    expect(contract!.commercial_snapshot).toMatchObject({ package: { key: "signature", base_price_cents: 200_000 }, subtotal_cents: 210_000 });
    const text = JSON.stringify(renderedContentSchema.parse(contract!.rendered_content));
    expect(text).toContain("Package: Signature (2,000.00 CAD)");
    expect(text).toContain("- 1 × Main reception sound system");
    expect(text).toContain("- 1 set of Uplights (pack of 4) (4 lights): 100.00 CAD");
    // The client's proposal said the same.
    expect(quantityText(view.offer!.gear.uplights_4, 1)).toBe("1 set of Uplights (pack of 4) (4 lights)");

    // Stored contracts never change: later catalog edits and a revision leave it as generated.
    const { data: revision } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    const { data: revised } = await must(staff.from("proposals").select("draft_offer").eq("id", revision!).single());
    expect((revised!.draft_offer as { price_overrides: unknown }).price_overrides).toEqual(offer.price_overrides);
    const { data: after } = await must(staff.from("contracts").select("*").eq("id", contract!.id).single());
    expect(after).toEqual(contract);
    const { data: catalogPrices } = await must(admin.from("packages").select("key, base_price_cents").eq("tenant_id", catalog.tenantId).order("key"));
    expect(catalogPrices).toEqual([{ key: "essential", base_price_cents: 150_000 }, { key: "premium", base_price_cents: 300_000 }, { key: "signature", base_price_cents: 999_900 }]);
  });
});
