"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { processOutboxQuietly } from "@/lib/email/outbox.server";
import { proposalLinkToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { requireStaff } from "@/lib/auth/staff";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, optionalText, text, UUID_RE, type ActionState } from "@/lib/forms";
import { parseMoneyToCents } from "@/lib/money";
import { parseOfferSnapshot, type OfferSnapshot } from "@/lib/pricing";
import { frozenOfferLogo, type BrandLogo } from "@/lib/branding/logo.server";
import type { Json } from "@/lib/supabase/database.types";

/** This proposal's price for a gear item, or a package's base price; the catalog is never changed. */
type PriceOverride = { gear_item_id: string; unit_price_cents: number } | { package_id: string; unit_price_cents: number };

/**
 * "price:<gear id>" and "package_price:<package id>" fields -> this
 * proposal's prices. Empty means the standard price. Money is parsed to
 * exact cents. Package prices count only for packages the draft offers.
 */
function readPriceOverrides(form: FormData, offeredPackages: string[]): { ok: true; overrides: PriceOverride[] } | { ok: false; error: string } {
  const overrides: PriceOverride[] = [];
  const seen = new Set<string>();
  for (const [name, value] of form.entries()) {
    const kind = name.startsWith("price:") ? "gear" : name.startsWith("package_price:") ? "package" : null;
    if (!kind || typeof value !== "string" || value.trim() === "") continue;
    const id = name.slice(name.indexOf(":") + 1);
    const cents = parseMoneyToCents(value);
    if (!UUID_RE.test(id)) return { ok: false, error: "Invalid custom price." };
    if (cents === null || cents > 100_000_000) return { ok: false, error: "Custom prices must be amounts like 200 or 200.00 (up to 1,000,000.00)." };
    if (seen.has(`${kind}:${id}`)) return { ok: false, error: "Each item can have one custom price." };
    seen.add(`${kind}:${id}`);
    if (kind === "gear") overrides.push({ gear_item_id: id, unit_price_cents: cents });
    else if (offeredPackages.includes(id)) overrides.push({ package_id: id, unit_price_cents: cents });
  }
  return { ok: true, overrides };
}

/**
 * Saves the event's single editable draft in place. Never freezes or sends:
 * the offer snapshot is created only by the send flow (step 6).
 * expectedVersion guards against another tab overwriting newer edits.
 */
export async function saveDraft(slug: string, proposalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  const expectedVersion = int(form, "draft_version", 0, 2_000_000_000);
  if (expectedVersion === null) return fail("Reload the page and try again.");
  const { data: current } = await supabase.from("proposals").select("draft_offer").eq("id", proposalId).maybeSingle();
  if (!current) return fail("Proposal not found.");

  const expiryDays = int(form, "expiry_days", 1, 365);
  if (expiryDays === null) return fail("Expiry must be 1 to 365 days.");
  const intro = optionalText(form, "intro");
  if (intro && intro.length > 10000) return fail("Intro is too long.");

  const popular = text(form, "popular");
  const packages: { package_id: string; is_popular: boolean }[] = [];
  for (const n of ["1", "2", "3"]) {
    const id = text(form, `package_${n}`);
    if (!id) continue;
    if (!UUID_RE.test(id)) return fail("Choose packages from the list.");
    packages.push({ package_id: id, is_popular: popular === n });
  }

  const addons: { gear_item_id: string; recommended_quantity: number; max_quantity: number }[] = [];
  for (const gearId of form.getAll("addon").filter((v): v is string => typeof v === "string")) {
    if (!UUID_RE.test(gearId)) return fail("Invalid addon.");
    const max = int(form, `max:${gearId}`, 1, 100);
    const rec = int(form, `rec:${gearId}`, 0, 100);
    if (max === null || rec === null || rec > max) return fail("Addons: preselected quantity must be between 0 and the maximum (1 to 100).");
    addons.push({ gear_item_id: gearId, recommended_quantity: rec, max_quantity: max });
  }
  const questionIds = form.getAll("question").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
  const prices = readPriceOverrides(form, packages.map((p) => p.package_id));
  if (!prices.ok) return fail(prices.error);

  const previous = (current.draft_offer ?? {}) as { template_id?: string | null };
  const draft: Json = {
    template_id: previous.template_id ?? null,
    intro,
    expiry_days: expiryDays,
    packages,
    addons,
    question_ids: questionIds,
    // Only when set, so drafts without custom prices keep their old shape.
    ...(prices.overrides.length > 0 ? { price_overrides: prices.overrides } : {}),
  };
  const { data: version, error } = await supabase.rpc("update_proposal_draft", { p_proposal_id: proposalId, p_expected_version: expectedVersion, p_offer: draft });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  return ok("Draft saved. Nothing has been sent.", version);
}

/**
 * Replaces the draft's contents with a template's (packages, add-ons,
 * questions, intro, expiry). Custom prices are kept for the packages the
 * template also offers and the gear it still charges for (its add-ons and the
 * gear its questions' rules require).
 */
export async function applyTemplate(slug: string, proposalId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const expectedVersion = int(form, "draft_version", 0, 2_000_000_000);
  if (expectedVersion === null) return fail("Reload the page and try again.");
  const templateId = text(form, "template_id");
  if (!UUID_RE.test(templateId)) return fail("Choose a template.");
  const [{ data: input, error: templateError }, { data: current }] = await Promise.all([
    supabase.rpc("proposal_offer_input_from_template", { p_template_id: templateId }),
    supabase.from("proposals").select("draft_offer").eq("id", proposalId).eq("tenant_id", tenant.id).maybeSingle(),
  ]);
  if (templateError || !input) return fail("Template not found.");
  const offer = input as { packages?: { package_id: string }[]; addons?: { gear_item_id: string }[]; question_ids?: string[] } & Record<string, Json>;
  const kept = await keptPriceOverrides(supabase, tenant.id, (current?.draft_offer ?? {}) as { price_overrides?: PriceOverride[] }, offer);
  const next: Json = kept.length > 0 ? { ...offer, price_overrides: kept } : offer;
  const { data: version, error } = await supabase.rpc("update_proposal_draft", { p_proposal_id: proposalId, p_expected_version: expectedVersion, p_offer: next });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  return ok("Template applied.", version);
}

/**
 * Custom prices of the current draft for what the new offer still charges
 * for: its packages (matched by package id, never by name) and its gear.
 */
async function keptPriceOverrides(
  supabase: Awaited<ReturnType<typeof requireStaff>>["supabase"],
  tenantId: string,
  current: { price_overrides?: PriceOverride[] },
  next: { packages?: { package_id: string }[]; addons?: { gear_item_id: string }[]; question_ids?: string[] },
): Promise<PriceOverride[]> {
  const overrides = Array.isArray(current.price_overrides) ? current.price_overrides : [];
  if (overrides.length === 0) return [];
  const offered = new Set((next.packages ?? []).map((p) => p.package_id));
  const charged = new Set((next.addons ?? []).map((a) => a.gear_item_id));
  if ((next.question_ids ?? []).length > 0) {
    const { data: rules } = await supabase
      .from("logistics_rules")
      .select("gear_item_id")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .in("question_id", next.question_ids!);
    for (const r of rules ?? []) charged.add(r.gear_item_id);
  }
  return overrides.filter((o) => ("package_id" in o ? offered.has(o.package_id) : charged.has(o.gear_item_id)));
}

export type DraftPreview = { ok: true; offer: OfferSnapshot; logo: BrandLogo | null } | { ok: false; message: string };

/**
 * The client preview of edits that aren't saved yet: preview_proposal_draft
 * validates and builds the snapshot exactly as sending would, from the
 * catalog of the proposal's business, and stores nothing. No save, no lock,
 * so it can never overwrite or race a save.
 */
export async function previewDraftOffer(slug: string, proposalId: string, offer: unknown): Promise<DraftPreview> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(proposalId) || !offer || typeof offer !== "object" || Array.isArray(offer)) return { ok: false, message: "Reload the page and try again." };
  const { data, error } = await supabase.rpc("preview_proposal_draft", { p_proposal_id: proposalId, p_offer: offer as Json });
  if (error) return { ok: false, message: describeDbError(error) };
  const snapshot = parseOfferSnapshot(data);
  return { ok: true, offer: snapshot, logo: await frozenOfferLogo(snapshot) };
}

/**
 * Sends the saved draft to the event's primary contact. One database
 * transaction freezes the offer, supersedes and revokes the previous offer,
 * creates the access link and queues the email; delivery happens afterwards.
 * The link token is derived from a fresh link id and only its hash is passed
 * to the database. The token itself is discarded here and re-derived by the
 * email worker. Sending is not a booking.
 */
export async function sendProposal(slug: string, proposalId: string, expectedVersion: number): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(proposalId) || !Number.isInteger(expectedVersion)) return fail("Reload the page and try again.");
  const linkId = randomUUID();
  const { data, error } = await supabase.rpc("send_proposal", {
    p_proposal_id: proposalId,
    p_expected_draft_version: expectedVersion,
    p_access_link_id: linkId,
    p_token_hash: sha256Hex(proposalLinkToken(linkId)),
  });
  if (error) {
    if (/proposal_already_sent/.test(error.message)) return fail("This proposal has already been sent.");
    return fail(describeDbError(error));
  }
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  const result = data as { recipient_email?: string };
  return ok(`Sent to ${result.recipient_email ?? "the client"}.`);
}

/** Approves the exact submitted selection. Prepares the contract phase; does not book the event. */
export async function approveSelection(slug: string, proposalId: string, selectionId: string): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  if (!UUID_RE.test(proposalId) || !UUID_RE.test(selectionId)) return fail("Reload the page and try again.");
  const { error } = await supabase.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selectionId });
  if (error) return fail(describeDbError(error));
  after(() => processOutboxQuietly(tenant.id));
  revalidatePath(`/staff/${slug}/proposals/${proposalId}`);
  return ok("Approved. The client has been notified that the contract will follow.");
}

/** Opens a revision draft prefilled from the current offer. Sending it later supersedes the current offer. */
export async function reviseProposal(slug: string, eventId: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(eventId)) return fail("Event not found.");
  const { data, error } = await supabase.rpc("open_proposal_draft", { p_event_id: eventId });
  if (error) return fail(describeDbError(error));
  redirect(`/staff/${slug}/proposals/${data}`);
}
