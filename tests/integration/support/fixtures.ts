/**
 * Shared fixtures for integration tests against the LOCAL Supabase stack.
 * Everything goes through the real database functions and roles: staff use
 * real magic-link sessions; client sessions are created by exchanging link
 * tokens exactly as the app's exchange route does.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseOfferSnapshot, priceSelection, toSelectionRecord, type OfferSnapshot } from "@/lib/pricing";
import { proposalLinkToken, sha256Hex } from "@/lib/proposals/tokens.server";

export type Db = SupabaseClient<Database>;
type LocalStatus = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

export function localStatus(): LocalStatus {
  const raw = execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const status = JSON.parse(raw) as LocalStatus;
  const host = new URL(status.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`Refusing to run against non-local Supabase: ${status.API_URL}`);
  return status;
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient(): Db {
  const env = localStatus();
  return createClient<Database>(env.API_URL, env.SERVICE_ROLE_KEY, opts);
}

export async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

/** Creates a confirmed user and signs them in through the magic-link token flow. */
export async function signedInUser(admin: Db, email: string): Promise<{ id: string; db: Db }> {
  const env = localStatus();
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw link.error;
  const db = createClient<Database>(env.API_URL, env.ANON_KEY, opts);
  await must(db.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" }));
  return { id: created.data.user.id, db };
}

export type Catalog = {
  tenantId: string;
  slug: string;
  templateId: string;
  gear: { main: string; speaker: string; mic: string; uplights: string };
  pkg: { essential: string; signature: string; premium: string };
};

/** A tenant with the spec's speaker-example catalog and a three-package template. */
export async function createTenantWithCatalog(admin: Db, ownerUserId: string, prefix: string): Promise<Catalog> {
  const run = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const slug = `${prefix}-${run}`;
  const templateId = randomUUID();
  const gear = { main: randomUUID(), speaker: randomUUID(), mic: randomUUID(), uplights: randomUUID() };
  const pkg = { essential: randomUUID(), signature: randomUUID(), premium: randomUUID() };
  const q = { ceremony: randomUUID(), cocktail: randomUUID(), speeches: randomUUID() };

  await must(
    admin.from("tenants").insert({
      id: tenantId,
      slug,
      business_name: `IT ${prefix}`,
      display_name: `IT ${prefix}`,
      reply_to_email: `${slug}@example.test`,
      business_address: "1 Test Street, Montréal, QC",
      contact_email: `contact-${slug}@example.test`,
      tax_config: [
        { code: "GST", label: "GST", rate_ppm: 50_000 },
        { code: "QST", label: "QST", rate_ppm: 99_750 },
      ],
      tax_categories: { standard: ["GST", "QST"] },
    }),
  );
  await must(admin.from("tenant_memberships").insert({ tenant_id: tenantId, user_id: ownerUserId, role: "owner" }));
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
  const options = [{ value: "same_room", label: "Same room" }, { value: "separate_space", label: "Separate space" }];
  await must(
    admin.from("logistics_questions").insert([
      { id: q.ceremony, tenant_id: tenantId, key: "ceremony_location", prompt: "Ceremony?", answer_type: "single_choice", sort_order: 1, options },
      { id: q.cocktail, tenant_id: tenantId, key: "cocktail_location", prompt: "Cocktails?", answer_type: "single_choice", sort_order: 2, options },
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
  return { tenantId, slug, templateId, gear, pkg };
}

/**
 * Ends test tenants: their due signed-PDF jobs are given up (as failed, the
 * normal outcome, so no worker later spends time on them ahead of real
 * jobs), then the tenants are archived. Their history stays.
 */
export async function archiveTestTenants(admin: Db, ...tenantIds: (string | undefined)[]) {
  for (const tenantId of tenantIds) {
    if (!tenantId) continue;
    try {
      for (let round = 0; round < 10; round++) {
        const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_tenant_id: tenantId, p_limit: 20, p_lease_seconds: 30 }));
        if (!jobs?.length) break;
        for (const job of jobs) {
          await admin.rpc("fail_document_job", { p_job_id: job.job_id, p_lease_token: job.lease_token, p_error: "Test tenant archived: PDF not needed.", p_permanent: true });
        }
      }
    } finally {
      await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", tenantId);
    }
  }
}

/** An event with a new primary contact. */
export async function createEvent(admin: Db, catalog: Catalog, clientEmail: string): Promise<{ eventId: string; clientId: string }> {
  const eventId = randomUUID();
  const clientId = randomUUID();
  await must(admin.from("clients").insert({ id: clientId, tenant_id: catalog.tenantId, name: "IT Client", email: clientEmail }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: catalog.tenantId, title: "IT wedding", event_type: "wedding", event_date: "2027-06-12", internal_notes: "IT staff-only secret" }));
  await must(admin.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  return { eventId, clientId };
}

/** Opens a draft from the template and sends it as staff, exactly as the send action does. */
export async function draftAndSend(staff: Db, catalog: Catalog, eventId: string): Promise<{ proposalId: string; linkId: string; token: string }> {
  const { data: input } = await must(staff.rpc("proposal_offer_input_from_template", { p_template_id: catalog.templateId }));
  const { data: proposalId } = await must(staff.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input! }));
  const sent = await sendDraft(staff, proposalId as string);
  return { proposalId: proposalId as string, ...sent };
}

export async function sendDraft(staff: Db, proposalId: string): Promise<{ linkId: string; token: string }> {
  const { data: draft } = await must(staff.from("proposals").select("draft_version").eq("id", proposalId).single());
  const linkId = randomUUID();
  const token = proposalLinkToken(linkId);
  await must(
    staff.rpc("send_proposal", {
      p_proposal_id: proposalId,
      p_expected_draft_version: draft!.draft_version,
      p_access_link_id: linkId,
      p_token_hash: sha256Hex(token),
    }),
  );
  return { linkId, token };
}

/** Exchanges a link token for a client session (as the exchange route does). Returns the session hash. */
export async function openLink(admin: Db, slug: string, token: string): Promise<{ status: string; sessionHash: string }> {
  const sessionHash = sha256Hex(randomBytes(32).toString("base64url"));
  const { data } = await must(
    admin.rpc("exchange_proposal_link", { p_token_hash: sha256Hex(token), p_session_hash: sessionHash, p_tenant_slug: slug, p_session_seconds: 3600 }),
  );
  return { status: (data as { status: string }).status, sessionHash };
}

export async function clientView(admin: Db, slug: string, proposalId: string, sessionHash: string) {
  const { data } = await must(admin.rpc("client_proposal_view", { p_session_hash: sessionHash, p_proposal_id: proposalId, p_tenant_slug: slug }));
  const view = data as { state: string; proposal?: { offer: unknown; offer_sha256: string }; selection_draft?: { version: number } | null };
  return { ...view, offer: view.proposal ? (parseOfferSnapshot(view.proposal.offer) as OfferSnapshot) : null };
}

/** Prices with the shared module and submits through client_submit_selection (as the submit action does). */
export async function submit(
  admin: Db,
  args: { slug: string; proposalId: string; sessionHash: string; draftVersion: number; key?: string; input: unknown },
): Promise<Record<string, unknown>> {
  const view = await clientView(admin, args.slug, args.proposalId, args.sessionHash);
  if (!view.offer || !view.proposal) return { status: view.state };
  const priced = priceSelection(view.offer, args.input);
  if (!priced.ok) return { status: "invalid", errors: priced.errors };
  const { data } = await must(
    admin.rpc("client_submit_selection", {
      p_session_hash: args.sessionHash,
      p_proposal_id: args.proposalId,
      p_tenant_slug: args.slug,
      p_expected_draft_version: args.draftVersion,
      p_idempotency_key: args.key ?? randomUUID().replaceAll("-", ""),
      p_selection: JSON.parse(JSON.stringify(toSelectionRecord(priced.selection, view.proposal.offer_sha256))),
    }),
  );
  return data as Record<string, unknown>;
}

export const bothSeparate = { ceremony_location: "separate_space", cocktail_location: "separate_space", speeches_wireless_mic: false };
