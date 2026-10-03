/**
 * Frozen offers and server pricing against the LOCAL Supabase stack.
 *
 * Staff (real magic-link session) draft, preview and send an offer. A client
 * session is opened from the link, and selections priced by the shared
 * TypeScript module are submitted through the session-checked database path,
 * which re-verifies prices, tax rounding and choices before committing. This
 * proves the TypeScript engine and the database agree.
 *
 * Proposals are immutable history and cannot be deleted, so the uniquely named
 * tenant is left behind, archived. `pnpm db:reset` removes it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseOfferSnapshot, priceSelection, toSelectionRecord } from "@/lib/pricing";
import {
  adminClient,
  bothSeparate,
  clientView,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  must,
  openLink,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

let admin: Db;
let staff: Db;
let catalog: Catalog;

describe("frozen offers and server pricing (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-offers-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-offers");
  });

  afterAll(async () => {
    if (admin && catalog) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", catalog.tenantId);
  });

  it("drafts and previews without freezing; only sending freezes", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-client-${randomUUID().slice(0, 6)}@example.test`);
    const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
    const { data: id } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input! }));
    const { data: preview } = await must(staff.rpc("preview_proposal_offer", { p_proposal_id: id as string }));
    expect(parseOfferSnapshot(preview).packages.map((p) => p.key)).toEqual(["essential", "signature", "premium"]);
    const { data: draft } = await must(staff.from("proposals").select("offer_snapshot, status").eq("id", id as string).single());
    expect(draft).toEqual({ offer_snapshot: null, status: "draft" });
    // The standalone freeze function no longer exists: freezing happens only inside send_proposal.
    const freeze = await admin.rpc("freeze_proposal_offer" as never, { p_proposal_id: id } as never);
    expect(freeze.error).toBeTruthy();
  });

  it("prices the spec speaker example and the database accepts the same numbers", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-client-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const result = await submit(admin, {
      slug: catalog.slug,
      proposalId,
      sessionHash,
      draftVersion: 0,
      input: { package_key: "signature", answers: bothSeparate, addons: { additional_location_speaker: 1 } },
    });
    expect(result.status).toBe("submitted");

    const { data: stored } = await must(
      admin
        .from("proposal_selections")
        .select("subtotal_cents, tax_cents, total_cents, proposal_selection_lines(source, item_key, quantity, line_total_cents)")
        .eq("proposal_id", proposalId)
        .single(),
    );
    expect(stored).toMatchObject({ subtotal_cents: 235_000, tax_cents: 35_191, total_cents: 270_191 });
    const charged = stored!.proposal_selection_lines.filter((l) => l.line_total_cents > 0);
    expect(charged.map((l) => [l.source, l.item_key, l.quantity])).toEqual([
      ["package", "signature", 1],
      ["required", "additional_location_speaker", 1],
    ]);
  });

  it("agrees with the database on half-up tax rounding across several selections", async () => {
    const inputs = [
      { package_key: "essential", answers: bothSeparate, addons: { uplights_4: 3 } },
      { package_key: "premium", answers: { ...bothSeparate, speeches_wireless_mic: true }, addons: { additional_location_speaker: 2 } },
      { package_key: "essential", answers: { ...bothSeparate, ceremony_location: "same_room", speeches_wireless_mic: true }, addons: { uplights_4: 1 } },
    ];
    for (const input of inputs) {
      const { eventId } = await createEvent(admin, catalog, `it-client-${randomUUID().slice(0, 6)}@example.test`);
      const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
      const { sessionHash } = await openLink(admin, catalog.slug, token);
      const result = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input });
      expect(result.status, JSON.stringify(input)).toBe("submitted");
    }
  });

  it("rejects stale tabs, invalid input and tampered amounts without storing anything", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-client-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const base = { slug: catalog.slug, proposalId, sessionHash };

    const stale = await submit(admin, { ...base, draftVersion: 3, input: { package_key: "essential", answers: bothSeparate } });
    expect(stale.status).toBe("conflict");

    const missing = await submit(admin, { ...base, draftVersion: 0, input: { package_key: "signature", answers: { ceremony_location: "same_room" } } });
    expect(missing.status).toBe("invalid");

    const tamperedInput = await submit(admin, { ...base, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate, total_cents: 1 } });
    expect(tamperedInput.status).toBe("invalid");

    // A writer that bypasses the pricing module and lowers a price is stopped by the database.
    const view = await clientView(admin, catalog.slug, proposalId, sessionHash);
    const priced = priceSelection(view.offer!, { package_key: "signature", answers: bothSeparate });
    if (!priced.ok) throw new Error("expected a valid selection");
    const record = toSelectionRecord(priced.selection, view.proposal!.offer_sha256);
    const speaker = record.lines.find((l) => l.source === "required")!;
    speaker.unit_price_cents = 1;
    speaker.line_total_cents = 1;
    record.subtotal_cents = record.lines.reduce((sum, l) => sum + l.line_total_cents, 0);
    record.total_cents = record.subtotal_cents + record.tax_cents;
    const { data } = await must(
      admin.rpc("client_submit_selection", {
        p_session_hash: sessionHash,
        p_proposal_id: proposalId,
        p_tenant_slug: catalog.slug,
        p_expected_draft_version: 0,
        p_idempotency_key: randomUUID().replaceAll("-", ""),
        p_selection: JSON.parse(JSON.stringify(record)),
      }),
    );
    expect((data as { status: string; message: string }).message).toMatch(/does not match the frozen offer/);

    const { count } = await admin.from("proposal_selections").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId);
    expect(count).toBe(0);
  });

  it("keeps sent terms and prices when the catalog changes; a new offer freezes the new catalog", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-client-${randomUUID().slice(0, 6)}@example.test`);
    const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
    const { sessionHash } = await openLink(admin, catalog.slug, token);
    const before = await clientView(admin, catalog.slug, proposalId, sessionHash);
    const pricedBefore = priceSelection(before.offer!, { package_key: "signature", answers: bothSeparate });

    await must(admin.from("gear_items").update({ default_price_cents: 99_999, name: "Renamed" }).eq("id", catalog.gear.speaker));
    await must(admin.from("packages").update({ base_price_cents: 1 }).eq("id", catalog.pkg.signature));

    const after = await clientView(admin, catalog.slug, proposalId, sessionHash);
    expect(after.proposal!.offer_sha256).toBe(before.proposal!.offer_sha256);
    expect(after.offer).toEqual(before.offer);
    expect(priceSelection(after.offer!, { package_key: "signature", answers: bothSeparate })).toEqual(pricedBefore);
    expect((await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } })).status).toBe("submitted");

    // A revision (which supersedes the sent offer) previews the current catalog.
    const { data: revisionId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId }));
    const { data: fresh } = await must(staff.rpc("preview_proposal_offer", { p_proposal_id: revisionId as string }));
    expect(parseOfferSnapshot(fresh).gear.additional_location_speaker.unit_price_cents).toBe(99_999);

    await must(admin.from("gear_items").update({ default_price_cents: 15_000, name: "Additional-location speaker" }).eq("id", catalog.gear.speaker));
    await must(admin.from("packages").update({ base_price_cents: 220_000 }).eq("id", catalog.pkg.signature));
  });
});
