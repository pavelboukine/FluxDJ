/**
 * Dedicated, throwaway tenants for browser tests. Tests never write to the
 * seeded BOUPROD or Other DJ tenants, so manual work there stays untouched.
 *
 * Each tenant gets its own owner login (an @example.test address), which is
 * the tenant's only member. Your own staff logins are never members, so test
 * tenants never appear in your staff workspace. The tenant is archived when
 * the suite finishes; proposals, contracts and audit rows are immutable
 * history, so they stay in the archived tenant instead of being deleted.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { parseOfferSnapshot, priceSelection, toSelectionRecord, type OfferSnapshot } from "../../src/lib/pricing";
import { admin } from "./support";

export type TestTenant = {
  id: string;
  slug: string;
  displayName: string;
  ownerEmail: string;
};

async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

/**
 * Creates a tenant with its own owner. With `catalog`, it also gets a copy of
 * the seed's DEMO catalog: the same gear, packages, questions, rules and
 * "Wedding (DEMO)" proposal template the tests rely on.
 */
export async function createTestTenant(suite: string, opts: { catalog?: boolean } = {}): Promise<TestTenant> {
  const run = randomUUID().slice(0, 8);
  const slug = `e2e-${suite}-${run}`;
  const ownerEmail = `e2e-owner-${suite}-${run}@example.test`;
  const displayName = `E2E DJ ${run}`;
  const id = randomUUID();

  const { data: user } = await must(admin.auth.admin.createUser({ email: ownerEmail, email_confirm: true }));
  await must(
    admin.from("tenants").insert({
      id,
      slug,
      business_name: `${displayName} Inc.`,
      display_name: displayName,
      brand_colors: { primary: "#111827", accent: "#E11D48" },
      reply_to_email: ownerEmail,
      business_address: "1 Test Street, Montréal, QC",
      contact_email: `contact-${run}@example.test`,
      tax_config: [
        { code: "GST", label: "GST", rate_ppm: 50_000 },
        { code: "QST", label: "QST", rate_ppm: 99_750 },
      ],
      tax_categories: { standard: ["GST", "QST"] },
    }),
  );
  await must(admin.from("tenant_memberships").insert({ tenant_id: id, user_id: user.user!.id, role: "owner" }));
  if (opts.catalog) await addDemoCatalog(id);
  return { id, slug, displayName, ownerEmail };
}

/** Archives a test tenant. Its immutable history stays, out of everyone's way. */
export async function archiveTestTenant(tenant: TestTenant | undefined) {
  if (tenant) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", tenant.id);
}

/** Mirrors the DEMO catalog in supabase/seed.sql. */
async function addDemoCatalog(tenantId: string) {
  const gear = { main: randomUUID(), speaker: randomUUID(), mic: randomUUID(), uplights: randomUUID(), lighting: randomUUID() };
  const pkg = { essential: randomUUID(), signature: randomUUID(), premium: randomUUID() };
  const q = { ceremony: randomUUID(), cocktail: randomUUID(), speeches: randomUUID(), venue: randomUUID() };
  const templateId = randomUUID();
  const t = (rows: Record<string, unknown>[]) => rows.map((r) => ({ tenant_id: tenantId, ...r }));

  await must(
    admin.from("gear_items").insert(
      t([
        { id: gear.main, key: "main_sound_system", name: "Main reception sound system", description: "DEMO: two tops and a sub for the main room.", unit_label: "system", default_price_cents: 0 },
        { id: gear.speaker, key: "additional_location_speaker", name: "Additional-location speaker", description: "DEMO: powered speaker on a stand for a separate ceremony or cocktail space.", unit_label: "speaker", default_price_cents: 15_000 },
        { id: gear.mic, key: "wireless_mic", name: "Wireless microphone", description: "DEMO: handheld wireless mic for speeches.", unit_label: "mic", default_price_cents: 5_000 },
        { id: gear.uplights, key: "uplights_4", name: "Uplights (pack of 4)", description: "DEMO: one unit is four colour-matched uplights.", unit_label: "pack", default_price_cents: 12_000 },
        { id: gear.lighting, key: "dance_floor_lighting", name: "Dance floor lighting", description: "DEMO: moving heads and wash lights over the dance floor.", unit_label: "set", default_price_cents: 20_000 },
      ]),
    ),
  );
  await must(
    admin.from("packages").insert(
      t([
        { id: pkg.essential, key: "essential", name: "Essential", description: "DEMO: reception DJ with main sound and one mic.", base_price_cents: 150_000, sort_order: 1, is_popular: false },
        { id: pkg.signature, key: "signature", name: "Signature", description: "DEMO: adds dance floor lighting and one additional-location speaker.", base_price_cents: 220_000, sort_order: 2, is_popular: true },
        { id: pkg.premium, key: "premium", name: "Premium", description: "DEMO: adds uplighting and a second additional-location speaker.", base_price_cents: 300_000, sort_order: 3, is_popular: false },
      ]),
    ),
  );
  await must(
    admin.from("package_items").insert(
      t([
        { package_id: pkg.essential, gear_item_id: gear.main, quantity: 1 },
        { package_id: pkg.essential, gear_item_id: gear.mic, quantity: 1 },
        { package_id: pkg.signature, gear_item_id: gear.main, quantity: 1 },
        { package_id: pkg.signature, gear_item_id: gear.mic, quantity: 2 },
        { package_id: pkg.signature, gear_item_id: gear.speaker, quantity: 1 },
        { package_id: pkg.signature, gear_item_id: gear.lighting, quantity: 1 },
        { package_id: pkg.premium, gear_item_id: gear.main, quantity: 1 },
        { package_id: pkg.premium, gear_item_id: gear.mic, quantity: 2 },
        { package_id: pkg.premium, gear_item_id: gear.speaker, quantity: 2 },
        { package_id: pkg.premium, gear_item_id: gear.lighting, quantity: 1 },
        { package_id: pkg.premium, gear_item_id: gear.uplights, quantity: 2 },
      ]),
    ),
  );
  const rooms = [{ value: "same_room", label: "Same room as the reception" }, { value: "separate_space", label: "A separate space" }];
  await must(
    admin.from("logistics_questions").insert(
      t([
        { id: q.ceremony, key: "ceremony_location", prompt: "DEMO: Where will the ceremony take place?", answer_type: "single_choice", options: [{ value: "no_ceremony", label: "No ceremony" }, ...rooms], sort_order: 1, required: true },
        { id: q.cocktail, key: "cocktail_location", prompt: "DEMO: Where will cocktail hour take place?", answer_type: "single_choice", options: rooms, sort_order: 2, required: true },
        { id: q.speeches, key: "speeches_wireless_mic", prompt: "DEMO: Will there be speeches that need a wireless microphone?", answer_type: "boolean", options: [], sort_order: 3, required: true },
        { id: q.venue, key: "venue_notes", prompt: "DEMO: Anything we should know about the venue (load-in, stairs, curfew)?", answer_type: "short_text", options: [], sort_order: 4, required: false },
      ]),
    ),
  );
  await must(
    admin.from("logistics_rules").insert(
      t([
        { question_id: q.ceremony, condition: { op: "equals", value: "separate_space" }, gear_item_id: gear.speaker, required_quantity: 1, reason: "DEMO: Your ceremony is in a separate space, so it needs its own speaker." },
        { question_id: q.cocktail, condition: { op: "equals", value: "separate_space" }, gear_item_id: gear.speaker, required_quantity: 1, reason: "DEMO: Cocktail hour is in a separate space, so it needs its own speaker." },
        { question_id: q.speeches, condition: { op: "equals", value: true }, gear_item_id: gear.mic, required_quantity: 1, reason: "DEMO: Speeches need a wireless microphone." },
      ]),
    ),
  );
  await must(
    admin.from("proposal_templates").insert({
      id: templateId,
      tenant_id: tenantId,
      name: "Wedding (DEMO)",
      intro: "DEMO: Thank you for considering us for your wedding. Choose a package, adjust the extras and submit it for review.",
      expiry_days: 14,
    }),
  );
  await must(
    admin.from("proposal_template_packages").insert(
      t([
        { template_id: templateId, package_id: pkg.essential, sort_order: 1 },
        { template_id: templateId, package_id: pkg.signature, sort_order: 2 },
        { template_id: templateId, package_id: pkg.premium, sort_order: 3 },
      ]),
    ),
  );
  await must(admin.from("proposal_templates").update({ default_package_id: pkg.signature }).eq("id", templateId));
  await must(
    admin.from("proposal_template_addons").insert(
      t([
        { template_id: templateId, gear_item_id: gear.uplights, recommended_quantity: 1, max_quantity: 4, sort_order: 1 },
        { template_id: templateId, gear_item_id: gear.speaker, recommended_quantity: 0, max_quantity: 3, sort_order: 2 },
        { template_id: templateId, gear_item_id: gear.mic, recommended_quantity: 0, max_quantity: 3, sort_order: 3 },
        { template_id: templateId, gear_item_id: gear.lighting, recommended_quantity: 0, max_quantity: 1, sort_order: 4 },
      ]),
    ),
  );
  await must(
    admin.from("proposal_template_questions").insert(
      t([
        { template_id: templateId, question_id: q.ceremony, sort_order: 1 },
        { template_id: templateId, question_id: q.cocktail, sort_order: 2 },
        { template_id: templateId, question_id: q.speeches, sort_order: 3 },
        { template_id: templateId, question_id: q.venue, sort_order: 4 },
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Flow helpers shared by browser specs
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A complete set of answers for whatever questions the offer asks. */
function answersFor(offer: OfferSnapshot) {
  const answers: Record<string, unknown> = {};
  for (const q of offer.questions) {
    if (q.answer_type === "boolean") answers[q.key] = false;
    else if (q.answer_type === "single_choice") answers[q.key] = q.options.find((o) => o.value === "same_room")?.value ?? q.options[0].value;
    else if (q.answer_type === "multi_choice") answers[q.key] = [];
    else answers[q.key] = "E2E notes";
  }
  return answers;
}

/**
 * The client opens the emailed link and submits the Signature package,
 * through the same service functions the client page calls (that page is
 * covered by proposal-flow.spec.ts). Returns the priced total.
 */
export async function submitAsClient(tenant: TestTenant, proposalId: string): Promise<{ totalCents: number }> {
  const { data: link } = await must(admin.from("access_links").select("token_hash").eq("proposal_id", proposalId).single());
  const sessionHash = sha256(randomBytes(32).toString("base64url"));
  await must(admin.rpc("exchange_proposal_link", { p_token_hash: link!.token_hash, p_session_hash: sessionHash, p_tenant_slug: tenant.slug, p_session_seconds: 3600 }));
  const { data: view } = await must(admin.rpc("client_proposal_view", { p_session_hash: sessionHash, p_proposal_id: proposalId, p_tenant_slug: tenant.slug }));
  const { proposal } = view as { proposal: { offer: unknown; offer_sha256: string } };
  const offer = parseOfferSnapshot(proposal.offer);
  const priced = priceSelection(offer, { package_key: "signature", answers: answersFor(offer) });
  if (!priced.ok) throw new Error(JSON.stringify(priced.errors));
  const { data: submitted } = await must(
    admin.rpc("client_submit_selection", {
      p_session_hash: sessionHash, p_proposal_id: proposalId, p_tenant_slug: tenant.slug, p_expected_draft_version: 0,
      p_idempotency_key: randomUUID().replaceAll("-", ""), p_selection: JSON.parse(JSON.stringify(toSelectionRecord(priced.selection, proposal.offer_sha256))),
    }),
  );
  expect((submitted as { status: string }).status).toBe("submitted");
  return { totalCents: priced.selection.total_cents };
}

/** Staff open a draft from "Wedding (DEMO)" on the event page and send it. Returns the proposal URL. */
export async function sendProposalFromEventPage(staff: Page, tenant: TestTenant, eventId: string): Promise<string> {
  await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
  await staff.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
  await staff.getByRole("button", { name: "Start proposal draft" }).click();
  await staff.waitForURL("**/proposals/**");
  const url = staff.url();
  await staff.getByRole("button", { name: "Review and send…" }).click();
  await staff.getByRole("dialog", { name: "Confirm sending" }).getByRole("button", { name: "Send proposal now" }).click();
  await expect(staff.getByText("Sent", { exact: true })).toBeVisible();
  return url;
}
