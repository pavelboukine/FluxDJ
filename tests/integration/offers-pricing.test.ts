/**
 * End-to-end offer and pricing test against the LOCAL Supabase stack.
 *
 * A staff user (real magic-link session) drafts and previews an offer from a
 * template; trusted code freezes it with freeze_proposal_offer. The snapshot is read back through RLS, validated by
 * the TypeScript schema, priced by the shared pricing module, and recorded
 * with priceAndRecordSelection. The commit runs the database's deferred
 * verification for real, so this also proves the TypeScript engine and the
 * database agree on prices and tax rounding.
 *
 * Proposals and selections are immutable by design and cannot be deleted, so
 * this test leaves its uniquely named tenant ("it-offers-*") behind, archived.
 * `pnpm db:reset` removes it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseOfferSnapshot, priceSelection, toSelectionRecord, type OfferSnapshot } from "@/lib/pricing";
import { priceAndRecordSelection } from "@/lib/proposals/selections.server";

type LocalStatus = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

function localStatus(): LocalStatus {
  const raw = execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const status = JSON.parse(raw) as LocalStatus;
  const host = new URL(status.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run integration tests against non-local Supabase: ${status.API_URL}`);
  }
  return status;
}

const run = randomUUID().slice(0, 8);
const tenantId = randomUUID();
const eventId = randomUUID();
const templateId = randomUUID();
const gear = {
  main: randomUUID(),
  speaker: randomUUID(),
  mic: randomUUID(),
  uplights: randomUUID(),
};
const pkg = { essential: randomUUID(), signature: randomUUID(), premium: randomUUID() };
const q = { ceremony: randomUUID(), cocktail: randomUUID(), speeches: randomUUID() };

const bothSeparate = {
  ceremony_location: "separate_space",
  cocktail_location: "separate_space",
  speeches_wireless_mic: false,
};

let admin: SupabaseClient<Database>;
let staff: SupabaseClient<Database>;
let staffUserId: string;
let proposalId: string;
let offer: OfferSnapshot;
let offerSha: string;

async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

describe("frozen offers and server pricing (local Supabase)", () => {
  beforeAll(async () => {
    const env = localStatus();
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient<Database>(env.API_URL, env.SERVICE_ROLE_KEY, opts);

    const email = `it-offers-${run}@example.test`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error) throw created.error;
    staffUserId = created.data.user.id;
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error) throw link.error;
    staff = createClient<Database>(env.API_URL, env.ANON_KEY, opts);
    await must(staff.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" }));

    await must(
      admin.from("tenants").insert({
        id: tenantId,
        slug: `it-offers-${run}`,
        business_name: "IT Offers",
        display_name: "IT Offers",
        tax_config: [
          { code: "GST", label: "GST", rate_ppm: 50_000 },
          { code: "QST", label: "QST", rate_ppm: 99_750 },
        ],
        tax_categories: { standard: ["GST", "QST"] },
      }),
    );
    await must(admin.from("tenant_memberships").insert({ tenant_id: tenantId, user_id: staffUserId, role: "owner" }));
    await must(
      admin.from("events").insert({ id: eventId, tenant_id: tenantId, title: "IT wedding", event_type: "wedding", event_date: "2027-06-12" }),
    );
    await must(
      admin.from("gear_items").insert([
        { id: gear.main, tenant_id: tenantId, key: "main_sound_system", name: "Main reception sound system", default_price_cents: 0 },
        { id: gear.speaker, tenant_id: tenantId, key: "additional_location_speaker", name: "Additional-location speaker", default_price_cents: 15_000 },
        { id: gear.mic, tenant_id: tenantId, key: "wireless_mic", name: "Wireless microphone", default_price_cents: 5_000 },
        { id: gear.uplights, tenant_id: tenantId, key: "uplights_4", name: "Uplights (pack of 4)", default_price_cents: 12_000 },
      ]),
    );
    await must(
      admin.from("packages").insert([
        { id: pkg.essential, tenant_id: tenantId, key: "essential", name: "Essential", base_price_cents: 150_000 },
        { id: pkg.signature, tenant_id: tenantId, key: "signature", name: "Signature", base_price_cents: 220_000 },
        { id: pkg.premium, tenant_id: tenantId, key: "premium", name: "Premium", base_price_cents: 300_000 },
      ]),
    );
    await must(
      admin.from("package_items").insert([
        { tenant_id: tenantId, package_id: pkg.essential, gear_item_id: gear.main, quantity: 1 },
        { tenant_id: tenantId, package_id: pkg.essential, gear_item_id: gear.mic, quantity: 1 },
        { tenant_id: tenantId, package_id: pkg.signature, gear_item_id: gear.main, quantity: 1 },
        { tenant_id: tenantId, package_id: pkg.signature, gear_item_id: gear.speaker, quantity: 1 },
        { tenant_id: tenantId, package_id: pkg.premium, gear_item_id: gear.main, quantity: 1 },
        { tenant_id: tenantId, package_id: pkg.premium, gear_item_id: gear.speaker, quantity: 2 },
      ]),
    );
    await must(
      admin.from("logistics_questions").insert([
        {
          id: q.ceremony, tenant_id: tenantId, key: "ceremony_location", prompt: "Ceremony?", answer_type: "single_choice", sort_order: 1,
          options: [{ value: "same_room", label: "Same room" }, { value: "separate_space", label: "Separate space" }],
        },
        {
          id: q.cocktail, tenant_id: tenantId, key: "cocktail_location", prompt: "Cocktails?", answer_type: "single_choice", sort_order: 2,
          options: [{ value: "same_room", label: "Same room" }, { value: "separate_space", label: "Separate space" }],
        },
        { id: q.speeches, tenant_id: tenantId, key: "speeches_wireless_mic", prompt: "Speeches?", answer_type: "boolean", options: [], sort_order: 3 },
      ]),
    );
    await must(
      admin.from("logistics_rules").insert([
        { tenant_id: tenantId, question_id: q.ceremony, condition: { op: "equals", value: "separate_space" }, gear_item_id: gear.speaker, required_quantity: 1, reason: "Separate ceremony space needs its own speaker." },
        { tenant_id: tenantId, question_id: q.cocktail, condition: { op: "equals", value: "separate_space" }, gear_item_id: gear.speaker, required_quantity: 1, reason: "Separate cocktail space needs its own speaker." },
        { tenant_id: tenantId, question_id: q.speeches, condition: { op: "equals", value: true }, gear_item_id: gear.mic, required_quantity: 1, reason: "Speeches need a wireless microphone." },
      ]),
    );
    await must(admin.from("proposal_templates").insert({ id: templateId, tenant_id: tenantId, name: "IT Wedding", expiry_days: 14 }));
    await must(
      admin.from("proposal_template_packages").insert([
        { tenant_id: tenantId, template_id: templateId, package_id: pkg.essential, sort_order: 1 },
        { tenant_id: tenantId, template_id: templateId, package_id: pkg.signature, sort_order: 2 },
        { tenant_id: tenantId, template_id: templateId, package_id: pkg.premium, sort_order: 3 },
      ]),
    );
    await must(admin.from("proposal_templates").update({ default_package_id: pkg.signature }).eq("id", templateId));
    await must(
      admin.from("proposal_template_addons").insert([
        { tenant_id: tenantId, template_id: templateId, gear_item_id: gear.uplights, recommended_quantity: 1, max_quantity: 4, sort_order: 1 },
        { tenant_id: tenantId, template_id: templateId, gear_item_id: gear.speaker, recommended_quantity: 0, max_quantity: 3, sort_order: 2 },
      ]),
    );
    await must(
      admin.from("proposal_template_questions").insert([
        { tenant_id: tenantId, template_id: templateId, question_id: q.ceremony, sort_order: 1 },
        { tenant_id: tenantId, template_id: templateId, question_id: q.cocktail, sort_order: 2 },
        { tenant_id: tenantId, template_id: templateId, question_id: q.speeches, sort_order: 3 },
      ]),
    );
  });

  afterAll(async () => {
    if (admin) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", tenantId);
  });

  it("drafts and previews as staff without freezing, then freezes once via trusted code", async () => {
    const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: templateId }));
    const { data: id } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input! }));
    proposalId = id as string;

    const { data: preview } = await must(staff.rpc("preview_proposal_offer", { p_proposal_id: proposalId }));
    expect(parseOfferSnapshot(preview).packages).toHaveLength(3);
    const { data: draft } = await must(staff.from("proposals").select("offer_snapshot").eq("id", proposalId).single());
    expect(draft!.offer_snapshot).toBeNull();

    const freezeAsStaff = await staff.rpc("freeze_proposal_offer", { p_proposal_id: proposalId });
    expect(freezeAsStaff.error?.code).toBe("42501");
    await must(admin.rpc("freeze_proposal_offer", { p_proposal_id: proposalId }));

    const { data: proposal } = await must(
      staff.from("proposals").select("offer_snapshot, offer_sha256, status").eq("id", proposalId).single(),
    );
    expect(proposal!.status).toBe("draft");
    offer = parseOfferSnapshot(proposal!.offer_snapshot);
    offerSha = proposal!.offer_sha256!;
    expect(offer.packages.map((p) => p.key)).toEqual(["essential", "signature", "premium"]);
    expect(offer.packages.find((p) => p.is_popular)?.key).toBe("signature");
  });

  it("prices the spec speaker example and the database accepts it at commit", async () => {
    const result = await priceAndRecordSelection(admin, proposalId, 0, {
      package_key: "signature",
      answers: bothSeparate,
      addons: { additional_location_speaker: 1 },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.version).toBe(1);
    expect(result.selection.total_cents).toBe(270_191);

    const { data: stored } = await must(
      admin
        .from("proposal_selections")
        .select("version, subtotal_cents, tax_cents, total_cents, proposal_selection_lines(source, item_key, quantity, line_total_cents)")
        .eq("id", result.selectionId)
        .single(),
    );
    expect(stored).toMatchObject({ version: 1, subtotal_cents: 235_000, tax_cents: 35_191, total_cents: 270_191 });
    const charged = stored!.proposal_selection_lines.filter((l) => l.line_total_cents > 0);
    expect(charged.map((l) => [l.source, l.item_key, l.quantity])).toEqual([
      ["package", "signature", 1],
      ["required", "additional_location_speaker", 1],
    ]);
  });

  it("agrees with the database on half-up tax rounding across many selections", async () => {
    let version = 1;
    const cases = [
      { package_key: "essential", answers: bothSeparate, addons: { uplights_4: 3 } },
      { package_key: "premium", answers: { ...bothSeparate, speeches_wireless_mic: true }, addons: { additional_location_speaker: 2 } },
      { package_key: "essential", answers: { ...bothSeparate, ceremony_location: "same_room", speeches_wireless_mic: true }, addons: { uplights_4: 1 } },
    ];
    for (const input of cases) {
      const result = await priceAndRecordSelection(admin, proposalId, version, input);
      if (!result.ok) throw new Error(JSON.stringify(result));
      version = result.version;
    }
    expect(version).toBe(4);
  });

  it("rejects stale versions, invalid input and tampered amounts without storing anything", async () => {
    const stale = await priceAndRecordSelection(admin, proposalId, 0, { package_key: "essential", answers: bothSeparate });
    expect(stale).toEqual({ ok: false, reason: "version_conflict" });

    const missing = await priceAndRecordSelection(admin, proposalId, 4, { package_key: "signature", answers: { ceremony_location: "same_room" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "invalid") {
      expect(missing.errors.map((e) => e.code)).toEqual(["answer_missing", "answer_missing"]);
    }

    const tamperedInput = await priceAndRecordSelection(admin, proposalId, 4, {
      package_key: "signature",
      answers: bothSeparate,
      total_cents: 1,
    });
    expect(tamperedInput.ok).toBe(false);

    // A writer that bypasses the pricing module and lowers a price is stopped at commit.
    const priced = priceSelection(offer, { package_key: "signature", answers: bothSeparate });
    if (!priced.ok) throw new Error("expected valid selection");
    const record = toSelectionRecord(priced.selection, offerSha);
    const speaker = record.lines.find((l) => l.source === "required")!;
    speaker.unit_price_cents = 1;
    speaker.line_total_cents = 1;
    record.subtotal_cents = record.lines.reduce((sum, l) => sum + l.line_total_cents, 0);
    record.total_cents = record.subtotal_cents + record.tax_cents;
    const { error } = await admin.rpc("record_proposal_selection", {
      p_proposal_id: proposalId,
      p_expected_version: 4,
      p_selection: JSON.parse(JSON.stringify(record)),
    });
    expect(error?.message).toMatch(/does not match the frozen offer/);

    const { data: proposal } = await must(admin.from("proposals").select("current_selection_version").eq("id", proposalId).single());
    expect(proposal!.current_selection_version).toBe(4);
  });

  it("keeps the frozen snapshot and its prices when the catalog changes", async () => {
    const before = priceSelection(offer, { package_key: "signature", answers: bothSeparate });

    await must(admin.from("gear_items").update({ default_price_cents: 99_999, name: "Renamed" }).eq("id", gear.speaker));
    await must(admin.from("packages").update({ base_price_cents: 1 }).eq("id", pkg.signature));
    await must(admin.from("package_items").delete().eq("package_id", pkg.signature).eq("gear_item_id", gear.speaker));
    await must(admin.from("logistics_rules").update({ required_quantity: 5 }).eq("question_id", q.ceremony));
    await must(
      admin
        .from("tenants")
        .update({ tax_config: [{ code: "GST", label: "GST", rate_ppm: 70_000 }], tax_categories: { standard: ["GST"] } })
        .eq("id", tenantId),
    );

    const { data: reloaded } = await must(admin.from("proposals").select("offer_snapshot, offer_sha256").eq("id", proposalId).single());
    expect(reloaded!.offer_sha256).toBe(offerSha);
    const reparsed = parseOfferSnapshot(reloaded!.offer_snapshot);
    expect(reparsed).toEqual(offer);
    expect(priceSelection(reparsed, { package_key: "signature", answers: bothSeparate })).toEqual(before);

    // Selections against the old offer still verify against the frozen terms.
    const result = await priceAndRecordSelection(admin, proposalId, 4, { package_key: "signature", answers: bothSeparate });
    expect(result.ok).toBe(true);

    // A new draft (after the first is sent), by contrast, previews the current catalog.
    await must(admin.from("proposals").update({ status: "sent" }).eq("id", proposalId));
    const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: templateId }));
    const { data: newId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input! }));
    const { data: fresh } = await must(admin.from("proposals").select("revision").eq("id", newId as string).single());
    const { data: freshPreview } = await must(staff.rpc("preview_proposal_offer", { p_proposal_id: newId as string }));
    const freshOffer = parseOfferSnapshot(freshPreview);
    expect(fresh!.revision).toBe(2);
    expect(freshOffer.gear.additional_location_speaker.unit_price_cents).toBe(99_999);
    expect(freshOffer.tax.rates).toEqual([{ code: "GST", label: "GST", rate_ppm: 70_000 }]);
  });
});
