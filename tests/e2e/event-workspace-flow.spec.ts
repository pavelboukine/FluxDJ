/**
 * The staff event workspace in real browsers, in a dedicated test business.
 * Each event is taken to its state through the same database functions the
 * app calls (as tests/e2e/booking.ts does; the screens for each step are
 * covered by the proposal, contract, signing and payment specs): new, draft,
 * sent, submitted, approved, contract draft (regenerated, so it has
 * history), contract sent, signed awaiting the deposit, booked, a legacy
 * contract, a deposit corrected after booking, and archived. Checks the
 * recommended next step, summaries, links, disclosures (deep links, unsaved
 * edits, errors) and phone layouts. E2E_SCREENSHOTS=1 keeps review shots.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, signInStaff } from "./support";
import { must, sessionFor } from "./booking";
import { archiveTestTenant, createTestTenant, publishContractTemplate, submitAsClient, type TestTenant } from "./tenant";
import { clearBookingPolicyLocally } from "../support/local-sql";

const run = randomUUID().slice(0, 6);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
// A 1x1 PNG: the signing function checks the stored object's type and size.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const STAGES = ["new", "draft", "sent", "submitted", "approved", "contract_draft", "contract_sent", "signed", "booked"] as const;
type Stage = (typeof STAGES)[number];
const reached = (upTo: Stage, stage: Stage) => STAGES.indexOf(upTo) >= STAGES.indexOf(stage);

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.serial("event workspace", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let staffDb: SupabaseClient;
  let versionId = "";
  let otherVersionId = "";
  const ev: Record<string, { id: string; contractId?: string; proposalId?: string }> = {};

  /** Creates an event with a primary contact and takes it to `upTo` through the app's database functions. */
  async function stage(key: string, title: string, upTo: Stage, opts: { venue?: string; legacy?: boolean; regenerate?: boolean } = {}) {
    const id = randomUUID();
    const clientId = randomUUID();
    const clientEmail = `e2e-ws-${key}-${run}@example.test`;
    await must(admin.from("events").insert({ id, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-10-30", timezone: "America/Toronto", venue_name: opts.venue ?? null }));
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: `Client ${key}`, email: clientEmail }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: id, client_id: clientId, is_primary: true, can_sign: true }));
    ev[key] = { id };
    if (!reached(upTo, "draft")) return;
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
    const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: id, p_offer: input }));
    ev[key].proposalId = proposalId as string;
    if (!reached(upTo, "sent")) return;
    const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
    await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: randomUUID().replaceAll("-", "").repeat(2) }));
    if (!reached(upTo, "submitted")) return;
    await submitAsClient(tenant, proposalId as string);
    if (!reached(upTo, "approved")) return;
    const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).not("submitted_at", "is", null).single());
    const { data: approval } = await must(staffDb.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));
    if (!reached(upTo, "contract_draft")) return;
    const approvalId = (approval as { approval_id: string }).approval_id;
    let { data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: versionId }));
    if (opts.regenerate) {
      // A different version, so the request isn't an identical replay: the first draft is replaced.
      ({ data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: approvalId, p_template_version_id: otherVersionId, p_replace_contract_id: (generated as { contract_id: string }).contract_id })));
    }
    const contractId = (generated as { contract_id: string }).contract_id;
    ev[key].contractId = contractId;
    if (!reached(upTo, "contract_sent")) return;
    if (opts.legacy) clearBookingPolicyLocally(contractId);
    const linkId = randomUUID();
    await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
    if (!reached(upTo, "signed")) return;
    const { data: user } = await must(admin.auth.admin.createUser({ email: clientEmail, email_confirm: true }));
    const clientDb = await sessionFor(clientEmail);
    await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
    const { data: c } = await must(admin.from("contracts").select("content_sha256, consent_version, deposit_cents").eq("id", contractId).single());
    const path = `${tenant.id}/${contractId}/${randomUUID()}.png`;
    await must(admin.storage.from("contract-signatures").upload(path, PNG, { contentType: "image/png" }));
    await must(admin.rpc("sign_contract", {
      p_contract_id: contractId, p_tenant_slug: tenant.slug, p_user_id: user.user!.id, p_typed_name: `Client ${key}`,
      p_content_sha256: c!.content_sha256, p_consent_version: c!.consent_version, p_consent_accepted: true, p_signature_path: path,
      p_signature_sha256: createHash("sha256").update(PNG).digest("hex"), p_signature_bytes: PNG.length, p_signature_width: 1, p_signature_height: 1,
      p_user_agent: "E2E", p_client_ip: null, p_client_ip_source: "unavailable",
    }));
    // No PDF needed here; retire this contract's job so signing specs never wait behind it.
    const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
    for (const j of (jobs ?? []) as { job_id: string; lease_token: string }[]) {
      await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "workspace e2e: PDF not needed", p_permanent: true });
    }
    if (!reached(upTo, "booked")) return;
    await must(staffDb.rpc("record_event_payment", {
      p_event_id: id, p_amount_cents: c!.deposit_cents, p_paid_on: "2026-10-01", p_reference: "E2E-WS", p_note: "", p_idempotency_key: randomUUID(), p_confirm_duplicate: false,
    }));
  }

  test.beforeAll(async ({ browser: b }) => {
    test.setTimeout(240_000);
    browser = b;
    tenant = await createTestTenant("ws", { catalog: true });
    staffDb = await sessionFor(tenant.ownerEmail);
    versionId = await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
    ]);
    otherVersionId = await publishContractTemplate(tenant, "Short agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Short agreement", [
      { heading: "Payment", body: "Deposit: {{payment.deposit}}." },
    ]);
    await stage("new", "New enquiry", "new");
    await stage("draft", "Draft wedding", "draft", { venue: "Le Windsor" });
    await stage("sent", "Sent wedding", "sent", { venue: "Le Windsor" });
    await stage("submitted", "Submitted wedding", "submitted", { venue: "Le Windsor" });
    await stage("approved", "Approved wedding", "approved", { venue: "Le Windsor" });
    await stage("cdraft", "Contract draft wedding", "contract_draft", { venue: "Le Windsor", regenerate: true });
    await stage("csent", "Contract sent wedding", "contract_sent", { venue: "Le Windsor" });
    await stage("deposit", "Noam & Justin Wedding", "signed", { venue: "Château Example" });
    await stage("booked", "Booked wedding", "booked", { venue: "Château Example" });
    await stage("legacy", "Legacy wedding", "signed", { venue: "Château Example", legacy: true });
    await stage("corrected", "Corrected wedding", "booked", { venue: "Château Example" });
    const { data: pay } = await must(admin.from("event_payments").select("id").eq("event_id", ev.corrected.id).single());
    await must(staffDb.rpc("invalidate_event_payment", { p_payment_id: pay!.id, p_reason: "E2E: payment bounced" }));
    await stage("archived", "Archived wedding", "submitted", { venue: "Le Windsor" });
    await must(staffDb.rpc("set_event_archived", { p_event_id: ev.archived.id, p_archived: true }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("each state recommends the step its records allow", async ({}, info) => {
    test.setTimeout(120_000);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}`;
    const expected: [string, string, string | null, string | null][] = [
      ["new", "create_proposal", "#proposal", null],
      ["draft", "continue_proposal", `${base}/proposals/${ev.draft.proposalId}`, null],
      ["sent", "awaiting_selection", null, `${base}/proposals/${ev.sent.proposalId}`],
      ["submitted", "review_submission", `${base}/proposals/${ev.submitted.proposalId}`, null],
      ["approved", "prepare_contract", "#contract", null],
      ["cdraft", "review_contract", `${base}/contracts/${ev.cdraft.contractId}`, null],
      ["csent", "awaiting_signature", null, `${base}/contracts/${ev.csent.contractId}`],
      ["deposit", "record_payment", "#record-payment", null],
      ["booked", "review_planning", `${base}/events/${ev.booked.id}/planning`, `${base}/events/${ev.booked.id}/run-sheet`],
      ["legacy", "check_booking", "#payments", null],
      ["corrected", "review_planning", `${base}/events/${ev.corrected.id}/planning`, `${base}/events/${ev.corrected.id}/run-sheet`],
      ["archived", "archived", null, "#manage"],
    ];
    for (const [key, action, primary, secondary] of expected) {
      await page.goto(`${base}/events/${ev[key].id}`);
      const next = page.getByTestId("next-action");
      await expect(next, key).toHaveAttribute("data-key", action);
      if (primary) await expect(next.getByTestId("next-action-primary"), key).toHaveAttribute("href", primary);
      else await expect(next.getByTestId("next-action-primary"), key).toHaveCount(0);
      if (secondary) await expect(next.getByTestId("next-action-secondary"), key).toHaveAttribute("href", secondary);
      else await expect(next.getByTestId("next-action-secondary"), key).toHaveCount(0);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      if (key === "new") await shot(page, info, "desktop-new");
      if (key === "deposit") await shot(page, info, "desktop-awaiting-deposit");
      if (key === "booked") await shot(page, info, "desktop-booked");
      if (key === "archived") await shot(page, info, "desktop-archived");
    }
    await page.context().close();
  });

  test("header, summaries and history read from the records", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}`;

    // Date-only values are never shifted; a missing venue says so.
    await page.goto(`${base}/events/${ev.new.id}`);
    await expect(page.getByTestId("event-meta")).toHaveText("Sat, Oct 30, 2027 · Venue not set · Wedding");
    await expect(page.getByTestId("overview-proposal")).toContainText("No proposal yet");
    await expect(page.getByTestId("overview-payments")).toContainText("No contract terms yet");
    await expect(page.getByTestId("overview-planning")).toContainText("Set up automatically when the event is booked.");

    // Awaiting the deposit: the signed terms from the summary, and the record form already open.
    await page.goto(`${base}/events/${ev.deposit.id}`);
    const { data: c } = await admin.from("contracts").select("total_cents, deposit_cents").eq("id", ev.deposit.contractId!).single();
    const money = (cents: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
    await expect(page.locator("[data-slot=badge]", { hasText: "Signed · awaiting deposit" })).toBeVisible();
    const pay = page.getByTestId("overview-payments");
    await expect(pay).toContainText("Signed contract terms");
    await expect(pay).toContainText(`Total${money(c!.total_cents)}`);
    await expect(pay).toContainText(`Deposit${money(c!.deposit_cents)}`);
    await expect(pay).toContainText(`Deposit due${money(c!.deposit_cents)}`);
    await expect(page.getByTestId("next-action")).toContainText(`${money(c!.deposit_cents)} is still due toward the deposit`);
    await expect(page.locator("#record-payment")).toHaveAttribute("open", "");
    await expect(page.getByLabel(/Amount received/)).toBeVisible();
    await expect(page.getByText("A contract has been signed for this event, so its terms can't be revised.")).toBeVisible();
    await expect(page.getByText(/was signed .*A signed contract can't be voided, replaced or revised/)).toBeVisible();

    // A sent contract's terms are labelled as not signed.
    await page.goto(`${base}/events/${ev.csent.id}`);
    await expect(page.getByTestId("overview-payments")).toContainText("Sent contract terms (not signed yet)");
    await expect(page.getByTestId("overview-contract")).toContainText("Sent, waiting for signature");

    // A regenerated draft keeps the replaced one in the history.
    await page.goto(`${base}/events/${ev.cdraft.id}`);
    const history = page.locator("#contract-history");
    await expect(history).not.toHaveAttribute("open", "");
    await history.locator("summary").click();
    await expect(history).toContainText("Replaced by a newer draft");

    // Booked: planning summary and links; a corrected deposit keeps the booking with a warning.
    await page.goto(`${base}/events/${ev.booked.id}`);
    await expect(page.getByTestId("overview-payments")).toContainText("Booking confirmed");
    await expect(page.getByTestId("overview-planning")).toContainText(/required answers|Available sections done|Nothing to fill in yet/);
    await expect(page.getByTestId("overview-planning")).toContainText("(America/Toronto)");
    await expect(page.locator("#planning").getByRole("link", { name: "Edit planning" })).toHaveAttribute("href", `${base}/events/${ev.booked.id}/planning`);
    await page.goto(`${base}/events/${ev.corrected.id}`);
    await expect(page.getByTestId("next-action")).toContainText("The booking stands, but valid payments no longer cover the deposit");
    await expect(page.getByLabel("Booking").getByRole("alert")).toContainText("The booking stands, but valid payments no longer cover the required deposit");
    await expect(page.getByTestId("overview-payments")).toContainText("Valid payments no longer cover the deposit; the booking stands.");

    // Archived: the notice, history, and no blocked actions.
    await page.goto(`${base}/events/${ev.archived.id}`);
    await expect(page.getByText("This event is archived.")).toBeVisible();
    await expect(page.locator("#record-payment")).toHaveCount(0);
    await expect(page.getByText("Unarchive the event to record or correct payments.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unarchive event" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a revised offer" })).toHaveCount(0);
    await expect(page.getByText("Unarchive the event to start or revise an offer.")).toBeVisible();
    await expect(page.locator("#planning").getByRole("link", { name: "Set up planning" })).toHaveCount(0);
    await expect(page.getByText("Unarchive the event to set up planning.")).toBeVisible();
    await page.context().close();
  });

  test("actions lead to the existing screens, and edits are never hidden", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const base = `/staff/${tenant.slug}`;

    await page.goto(`${base}/events/${ev.new.id}`);
    await page.getByTestId("next-action-primary").click();
    await expect(page).toHaveURL(/#proposal$/);
    await expect(page.getByLabel("Start from template")).toBeInViewport();

    await page.goto(`${base}/events/${ev.submitted.id}`);
    await page.getByTestId("next-action-primary").click();
    await expect(page).toHaveURL(new RegExp(`/proposals/${ev.submitted.proposalId}$`));
    await expect(page.getByRole("button", { name: "Approve…" })).toBeVisible();

    await page.goto(`${base}/events/${ev.approved.id}`);
    await page.getByTestId("next-action-primary").click();
    await expect(page.getByRole("button", { name: "Generate contract draft" })).toBeInViewport();

    // A deep link (the dashboard's deposit item) opens the form it points at.
    await page.goto(`${base}/events/${ev.booked.id}#record-payment`);
    await expect(page.locator("#record-payment")).toHaveAttribute("open", "");
    await expect(page.getByLabel(/Amount received/)).toBeVisible();

    // Edit details: opened from the header; unsaved edits and errors keep it open.
    await page.goto(`${base}/events/${ev.draft.id}`);
    const edit = page.locator("#edit-details");
    await expect(edit).not.toHaveAttribute("open", "");
    await page.getByRole("link", { name: "Edit details" }).click();
    await expect(edit).toHaveAttribute("open", "");
    await edit.getByLabel("Timezone").fill("Not a zone!");
    await expect(edit.locator("summary")).toContainText("Unsaved changes");
    await edit.locator("summary").click();
    await expect(edit).toHaveAttribute("open", ""); // can't collapse over unsaved edits
    await edit.getByRole("button", { name: "Save event" }).click();
    await expect(edit.getByRole("alert")).toContainText("Enter an IANA timezone such as America/Toronto.");
    await expect(edit).toHaveAttribute("open", "");
    await edit.getByLabel("Timezone").fill("America/Toronto");
    await edit.getByLabel("Venue name").fill("Le Windsor Ballroom");
    await edit.getByRole("button", { name: "Save event" }).click();
    await expect(edit.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("event-details")).toContainText("Le Windsor Ballroom");

    // Contacts: primary and signer are labelled; adding a primary says whom it replaces.
    await expect(page.locator("#contacts")).toContainText("Primary");
    await expect(page.locator("#contacts")).toContainText("Signer");
    await page.locator("#add-contact summary").click();
    await expect(page.locator("#add-contact")).toContainText("Replaces Client draft as primary contact and signer.");

    // Legacy: the check runs from the payments section; without the deposit, the event waits for it.
    await page.goto(`${base}/events/${ev.legacy.id}`);
    await page.getByTestId("next-action-primary").click();
    await page.getByLabel("Booking").getByRole("button", { name: "Check booking" }).click();
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-key", "record_payment");
    await page.context().close();
  });

  test("on a phone: compact header, stacked sections, nothing scrolls sideways", async ({}, info) => {
    for (const width of [390, 320]) {
      const page = await (await browser.newContext({ ...PHONE, viewport: { width, height: 844 } })).newPage();
      await signInStaff(page, tenant.ownerEmail);
      for (const key of ["new", "deposit", "booked", "archived"]) {
        await page.goto(`/staff/${tenant.slug}/events/${ev[key].id}`);
        await expect(page.getByTestId("next-action")).toBeVisible();
        expect(await sideways(page), `${key} at ${width}`).toBeLessThanOrEqual(0);
        if (width === 390) await shot(page, info, `phone-${key}`);
      }
      await page.context().close();
    }
  });
});
