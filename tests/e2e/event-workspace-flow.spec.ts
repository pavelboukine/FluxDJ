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
import { clearBookingPolicyLocally, placePlanningDeadline } from "../support/local-sql";

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
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The workspace's sections, in document order (Documents contains the contract and proposal rows once signed). */
const SECTIONS = ["proposal", "contract", "payments", "planning", "client-access", "documents", "communications", "contacts", "details", "manage"];
const sectionOrder = (page: Page) =>
  page.evaluate((ids) => ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map((e) => e.id), SECTIONS);
/** The bottom of the shell's fixed header (its progress line sits on it): nothing should land under it. */
const headerBottom = (page: Page) => page.getByTestId("navigation-progress").evaluate((e) => e.getBoundingClientRect().bottom);
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.serial("event workspace", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let staffDb: SupabaseClient;
  let versionId = "";
  let otherVersionId = "";
  const ev: Record<string, { id: string; contractId?: string; proposalId?: string }> = {};

  /**
   * Creates an event with a primary contact and takes it to `upTo` through the app's database functions.
   * `planned`: staff set planning up (Event basics only) before the booking; otherwise booking does, and
   * without a default template it waits for staff to choose one.
   */
  async function stage(key: string, title: string, upTo: Stage, opts: { venue?: string; legacy?: boolean; regenerate?: boolean; planned?: boolean; external?: boolean } = {}) {
    const id = randomUUID();
    const clientId = randomUUID();
    const clientEmail = `e2e-ws-${key}-${run}@example.test`;
    await must(admin.from("events").insert({ id, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-10-30", timezone: "America/Toronto", venue_name: opts.venue ?? null, ...(opts.external ? { booking_source: "external" } : {}) }));
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
    if (opts.planned) await must(staffDb.rpc("setup_event_plan", { p_event_id: id, p_template_id: null as unknown as string }));
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
    await stage("booked", "Booked wedding", "booked", { venue: "Château Example", planned: true });
    await stage("legacy", "Legacy wedding", "signed", { venue: "Château Example", legacy: true });
    await stage("corrected", "Corrected wedding", "booked", { venue: "Château Example" });
    const { data: pay } = await must(admin.from("event_payments").select("id").eq("event_id", ev.corrected.id).single());
    await must(staffDb.rpc("invalidate_event_payment", { p_payment_id: pay!.id, p_reason: "E2E: payment bounced" }));
    await stage("archived", "Archived wedding", "submitted", { venue: "Le Windsor" });
    await must(staffDb.rpc("set_event_archived", { p_event_id: ev.archived.id, p_archived: true }));
    await stage("external", "External wedding", "new", { venue: "Le Windsor", external: true });
    // A revised offer: revision 1 is replaced by a sent revision 2, so the proposal has a history.
    await stage("revised", "Revised wedding", "sent", { venue: "Le Windsor" });
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
    const { data: revision } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: ev.revised.id, p_offer: input }));
    const { data: revDraft } = await must(admin.from("proposals").select("draft_version").eq("id", revision).single());
    await must(staffDb.rpc("send_proposal", { p_proposal_id: revision, p_expected_draft_version: revDraft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: randomUUID().replaceAll("-", "").repeat(2) }));
    // Booked, with the client's planning deadline passed.
    await stage("passed", "Deadline passed wedding", "booked", { venue: "Château Example", planned: true });
    placePlanningDeadline(ev.passed.id, -24);
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
      // Not invited to planning yet: the separate planning invitation is offered next to reviewing planning.
      ["booked", "review_planning", `${base}/events/${ev.booked.id}/planning`, "#client-access"],
      ["legacy", "check_booking", "#payments", null],
      // Booked with Event basics only (no default template): staff choose the template first.
      ["corrected", "set_up_planning", `${base}/events/${ev.corrected.id}/planning`, null],
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
    // Each section states its own status; there are no separate summary tiles or section links.
    await expect(page.locator("[data-testid^='overview-']")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Event sections" })).toHaveCount(0);
    await expect(page.locator("#proposal").getByRole("button", { name: "Start proposal draft" })).toBeVisible();
    await expect(page.locator("#payments")).toContainText("No contract has been sent yet, so there is no total or deposit to compare.");
    await expect(page.locator("#planning")).toContainText("Booking sets it up automatically");

    // Awaiting the deposit: the signed terms from the summary, and the record form already open.
    await page.goto(`${base}/events/${ev.deposit.id}`);
    const { data: c } = await admin.from("contracts").select("total_cents, deposit_cents").eq("id", ev.deposit.contractId!).single();
    const money = (cents: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
    await expect(page.locator("[data-slot=badge]", { hasText: "Signed · awaiting deposit" })).toBeVisible();
    // At a glance: total, received and balance, and what is owed next (straight from the database summary).
    const figures = page.getByTestId("payment-figures");
    await expect(figures).toContainText(`Total${money(c!.total_cents)}`);
    await expect(figures).toContainText("Received$0.00");
    await expect(figures).toContainText(`Balance${money(c!.total_cents)}`);
    await expect(page.getByTestId("payment-next")).toHaveText(`${money(c!.deposit_cents)} still due toward the deposit`);
    // The full terms (deposit percentage, outstanding deposit) behind "Payment terms".
    await expect(page.locator("#payment-terms")).not.toHaveAttribute("open", "");
    await expect(page.locator("#payment-terms > summary")).toContainText(/Deposit \d+%/);
    const pay = page.getByLabel("Payment summary");
    await expect(pay).toContainText("Terms of the signed contract.");
    await expect(pay).toContainText(`Total, including taxes${money(c!.total_cents)}`);
    await expect(pay).toContainText(new RegExp(`Deposit required \\(\\d+%\\)${escape(money(c!.deposit_cents))}`));
    await expect(pay).toContainText(`Deposit still outstanding${money(c!.deposit_cents)}`);
    await expect(page.getByTestId("next-action")).toContainText(`${money(c!.deposit_cents)} is still due toward the deposit`);
    await expect(page.locator("#record-payment")).toHaveAttribute("open", "");
    await expect(page.getByLabel(/Amount received/)).toBeVisible();
    // Signed: the proposal and contract are documents now, with the terms locked.
    const documents = page.getByTestId("documents");
    await expect(documents.getByText("A contract has been signed for this event, so its terms can't be revised.")).toBeVisible();
    // Times in the event's own zone, with its abbreviation (the server's zone is UTC in production).
    await expect(documents.getByTestId("document-contract")).toContainText(/signed \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [ap]\.m\. E[DS]T/);
    await expect(documents.getByTestId("document-contract")).toHaveAttribute("href", `${base}/contracts/${ev.deposit.contractId}`);
    await expect(documents.getByTestId("document-proposal")).toHaveAttribute("href", `${base}/proposals/${ev.deposit.proposalId}`);
    await expect(documents.getByTestId("document-proposal")).toContainText("Approved");

    // A sent contract's terms are labelled as not signed.
    await page.goto(`${base}/events/${ev.csent.id}`);
    await expect(page.getByLabel("Payment summary")).toContainText("Terms of the contract sent to the client. It isn't signed yet");
    await expect(page.locator("#contract")).toContainText("was sent and is waiting for the client's signature");

    // A regenerated draft keeps the replaced one in the history.
    await page.goto(`${base}/events/${ev.cdraft.id}`);
    const history = page.locator("#contract-history");
    await expect(history).not.toHaveAttribute("open", "");
    await history.locator("summary").click();
    await expect(history).toContainText("Replaced by a newer draft");

    // Booked: planning summary and links; a corrected deposit keeps the booking with a warning.
    await page.goto(`${base}/events/${ev.booked.id}`);
    await expect(page.getByLabel("Booking")).toContainText("Booked · confirmed");
    await expect(page.locator("#planning")).toContainText(/required answers|Available sections done|Nothing to fill in yet/);
    // The deadline compactly, in the event's zone (also the business's, so not named), with the time; the full timestamp on hover.
    const editingLine = page.getByTestId("planning-card-editing");
    await expect(editingLine).toHaveText(/^Client editing closes \w{3} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [ap]\.m\.$/);
    await expect(editingLine).toHaveAttribute("title", /\(America\/Toronto\)$/);
    await expect(page.locator("#planning").getByRole("link", { name: "Open planning" })).toHaveAttribute("href", `${base}/events/${ev.booked.id}/planning`);
    await expect(page.locator("#planning").getByRole("link", { name: "Open run sheet" })).toHaveAttribute("href", `${base}/events/${ev.booked.id}/run-sheet`);
    // Client access is part of Planning: the signing client already has access (from the contract), and the
    // separate planning invitation is offered right there.
    const access = page.locator("#planning").getByTestId("client-access");
    await expect(access.getByTestId("client-access-headline")).toHaveText("Has access");
    await expect(access.getByTestId("client-access-state")).toContainText("The client has verified access and can open planning");
    await expect(access.getByRole("button", { name: "Send planning invitation" })).toBeVisible();
    // Event details no longer repeat the header (title, date, venue, type, booking); the edit form still has every field.
    await expect(page.getByTestId("event-details")).not.toContainText(/Château Example|Wedding|Through Flux DJ/);
    for (const field of ["Title", "Type", "Date", "Timezone", "Venue name", "Venue address"]) await expect(page.locator("#edit-details").getByLabel(field, { exact: true })).toHaveCount(1);
    // Past the deadline: closed for the client, staff can still edit; the next step says so too.
    await page.goto(`${base}/events/${ev.passed.id}`);
    await expect(page.getByTestId("planning-card-editing")).toHaveText(/^Client editing closed \w{3} \d{1,2}, \d{1,2}:\d{2} [ap]\.m\.; staff can still edit$/);
    await expect(page.getByTestId("next-action")).toContainText("Client editing is closed. Check the final answers and the run sheet.");
    await page.goto(`${base}/events/${ev.corrected.id}`);
    await expect(page.getByTestId("next-action")).toContainText("The booking stands, but valid payments no longer cover the deposit");
    await expect(page.locator("#planning")).toContainText("Not set up");
    await expect(page.locator("#planning").getByRole("link", { name: "Set up planning" })).toHaveAttribute("href", `${base}/events/${ev.corrected.id}/planning`);
    await expect(page.getByLabel("Booking").getByRole("alert")).toContainText("The booking stands, but valid payments no longer cover the required deposit");

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
    await expect(page.getByTestId("event-meta")).toContainText("Le Windsor Ballroom");

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

  test("sections follow the event's stage: one column on phones, two from xl, no summary tiles", async () => {
    const expected: Record<string, { order: string[]; compact: boolean }> = {
      // Booking: the proposal and contract lead; contacts and details are open.
      new: { order: ["proposal", "contract", "payments", "planning", "communications", "contacts", "details", "manage"], compact: false },
      archived: { order: ["proposal", "contract", "payments", "planning", "communications", "contacts", "details", "manage"], compact: false },
      // Signed, awaiting the deposit: payments lead; the signed contract and proposal are documents.
      deposit: { order: ["payments", "planning", "documents", "contract", "proposal", "communications", "contacts", "details", "manage"], compact: true },
      // Booked: payments, then planning and client access; documents are secondary.
      booked: { order: ["payments", "planning", "client-access", "documents", "contract", "proposal", "communications", "contacts", "details", "manage"], compact: true },
      // Past the client's planning deadline: still the booked layout.
      passed: { order: ["payments", "planning", "client-access", "documents", "contract", "proposal", "communications", "contacts", "details", "manage"], compact: true },
      // A revised offer is still booking.
      revised: { order: ["proposal", "contract", "payments", "planning", "communications", "contacts", "details", "manage"], compact: false },
      // Booked elsewhere: planning only, never a proposal, contract or payments.
      external: { order: ["planning", "client-access", "communications", "contacts", "details", "manage"], compact: true },
    };
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext(width === 1440 ? { viewport: { width, height: 1000 } } : { ...PHONE, viewport: { width, height: 844 } });
      const page = await context.newPage();
      await signInStaff(page, tenant.ownerEmail);
      for (const [key, want] of Object.entries(expected)) {
        const at = `${key} at ${width}`;
        await page.goto(`/staff/${tenant.slug}/events/${ev[key].id}`);
        await expect(page.getByTestId("next-action"), at).toBeVisible();
        expect(await sectionOrder(page), at).toEqual(want.order);
        await expect(page.locator("[data-testid^='overview-']"), at).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: "Event sections" }), at).toHaveCount(0);
        // The next step comes first in the main column; documents, emails, contacts, details and archiving are supporting.
        const main = page.getByTestId("workspace-main");
        const secondary = page.getByTestId("workspace-secondary");
        await expect(main.locator(":scope > *").first(), at).toHaveAttribute("data-testid", "next-action");
        for (const id of ["communications", "contacts", "details", "manage", ...(want.order.includes("documents") ? ["documents"] : [])]) {
          await expect(secondary.locator(`#${id}`), `${id}, ${at}`).toHaveCount(1);
        }
        const signedDocs = want.order.includes("documents");
        for (const id of want.order.filter((id) => ["payments", "planning", "client-access"].includes(id) || (!signedDocs && ["proposal", "contract"].includes(id)))) {
          await expect(main.locator(`#${id}`), `${id}, ${at}`).toHaveCount(1);
        }
        // Contacts and details: one line each once booked, open while booking.
        for (const id of ["contacts", "details"]) {
          if (want.compact) await expect(page.locator(`#${id}`), `${id}, ${at}`).not.toHaveAttribute("open", "");
          else await expect(page.locator(`#${id}`), `${id}, ${at}`).toHaveAttribute("open", "");
        }
        await expect(page.locator("#contacts > summary"), at).toContainText(`Client ${key} · ${key === "external" ? "primary" : "primary & signer"}`);
        await expect(page.locator("#details > summary"), at).toContainText("No address");
        const mainBox = (await main.boundingBox())!;
        const sideBox = (await secondary.boundingBox())!;
        if (width === 1440) {
          expect(sideBox.x, at).toBeGreaterThan(mainBox.x + mainBox.width - 1);
          expect(sideBox.y, at).toBeLessThan(mainBox.y + 1);
        } else {
          expect(Math.abs(sideBox.x - mainBox.x), at).toBeLessThanOrEqual(1);
          expect(sideBox.y, at).toBeGreaterThan(mainBox.y + mainBox.height - 1);
        }
        expect(await sideways(page), at).toBeLessThanOrEqual(0);
      }
      await context.close();
    }
  });

  test("document rows: the whole row opens the document, 44px tall, focus visible, with the pending line", async () => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext(viewport.width === 1440 ? { viewport } : { ...PHONE, viewport });
      const page = await context.newPage();
      await signInStaff(page, tenant.ownerEmail);
      const at = `at ${viewport.width}`;
      await page.goto(`/staff/${tenant.slug}/events/${ev.booked.id}`);
      const row = page.getByTestId("document-contract");
      await expect(row, at).toHaveAccessibleName(/^Contract .*signed .* Signed$/);
      for (const r of [row, page.getByTestId("document-proposal")]) {
        expect((await r.boundingBox())!.height, at).toBeGreaterThanOrEqual(44);
        // Nothing interactive inside a row.
        await expect(r.locator("a, button, input, select, textarea, [tabindex]"), at).toHaveCount(0);
      }
      // Keyboard focus is visible (the ring is a box shadow).
      await row.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(row, at).toBeFocused();
      expect(await row.evaluate((e) => e.matches(":focus-visible") && getComputedStyle(e).boxShadow !== "none"), at).toBe(true);
      // Focus never leaves it under the shell's sticky header.
      expect((await row.boundingBox())!.y, at).toBeGreaterThanOrEqual((await headerBottom(page)) - 1);
      // A click anywhere on the row, here by its chevron, navigates; a slow response shows the shell's pending line.
      const contractPath = `/staff/${tenant.slug}/contracts/${ev.booked.contractId}`;
      await page.route((url) => url.pathname === contractPath, async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      const box = (await row.boundingBox())!;
      await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
      await expect(page.getByTestId("navigation-progress"), at).toHaveAttribute("data-pending", "");
      await page.waitForURL(`**${contractPath}`);
      await expect(page.getByTestId("navigation-progress"), at).not.toHaveAttribute("data-pending", "");
      await context.close();
    }
  });

  /**
   * Every in-page destination the next step, the dashboard and other pages link to lands on what it
   * names, below the shell's header, on a phone: on load, from another page, on hash changes and
   * back/forward, on a second click of the same link, through collapsed and nested sections, and never
   * over unsaved edits.
   */
  test("every section anchor lands on its section, also after hash changes and back/forward", async () => {
    const page = await (await browser.newContext(PHONE)).newPage();
    await signInStaff(page, tenant.ownerEmail);
    const url = `/staff/${tenant.slug}/events/${ev.booked.id}`;
    const lands = async (id: string) => {
      const target = page.locator(`[id="${id}"]`);
      await expect(target, id).toBeInViewport();
      if ((await target.evaluate((el) => el.tagName)) === "DETAILS") await expect(target, id).toHaveAttribute("open", "");
      // Every collapsed section around it is open too.
      expect(await target.evaluate((el) => { const closed = el.parentElement?.closest("details:not([open])"); return closed ? closed.id : null; }), id).toBeNull();
      const bottom = await headerBottom(page);
      await expect.poll(() => target.evaluate((el) => el.getBoundingClientRect().top), id).toBeGreaterThanOrEqual(bottom - 1);
    };
    // Booked: contacts and details start collapsed; #add-contact and #edit-details are disclosures inside them.
    await page.goto(url);
    await expect(page.locator("#contacts")).not.toHaveAttribute("open", "");
    await expect(page.locator("#details")).not.toHaveAttribute("open", "");
    const anchors = ["proposal", "contract", "payments", "record-payment", "payment-history", "payment-terms", "invoice-link", "planning", "client-access", "communications", "contacts", "add-contact", "details", "edit-details", "manage"];
    for (const id of anchors) {
      await page.goto("about:blank");
      await page.goto(`${url}#${id}`);
      await lands(id);
    }
    // History disclosures (the contract draft was regenerated; the revised offer replaced revision 1).
    await page.goto(`/staff/${tenant.slug}/events/${ev.cdraft.id}#contract-history`);
    await lands("contract-history");
    await page.goto(`/staff/${tenant.slug}/events/${ev.revised.id}#proposal-history`);
    await lands("proposal-history");
    await expect(page.locator("#proposal-history")).toContainText("Revision 1");
    // A contact that couldn't be attached at creation: the alert, and Contacts open (even once booked).
    await page.goto(`${url}?contact=failed`);
    await expect(page.getByRole("alert").filter({ hasText: "its contact could not be attached" })).toBeVisible();
    await expect(page.locator("#contacts")).toHaveAttribute("open", "");
    await expect(page.locator("#add-contact > summary")).toBeVisible();

    // From another page through the router: the dashboard's deposit item.
    await page.goto(`/staff/${tenant.slug}`);
    await page.locator(`a[href$="/events/${ev.deposit.id}#record-payment"]`).first().click();
    await page.waitForURL(`**/events/${ev.deposit.id}#record-payment`);
    await lands("record-payment");
    await expect(page.getByLabel(/Amount received/)).toBeVisible();

    // Hash changes on the open page, then back and forward between them.
    await page.goto(url);
    const invoice = page.locator("#invoice-link");
    await expect(invoice).not.toHaveAttribute("open", "");
    // The router records its first history entry once the page is live; a hash set before then is replaced.
    await page.waitForFunction(() => (window.history.state as { __NA?: boolean } | null)?.__NA === true);
    await page.evaluate(() => { window.location.hash = "#invoice-link"; });
    await lands("invoice-link");
    await invoice.locator("summary").click();
    await expect(invoice).not.toHaveAttribute("open", "");
    await page.evaluate(() => { window.location.hash = "#edit-details"; });
    await lands("edit-details");
    await page.goBack();
    await expect(page).toHaveURL(/#invoice-link$/);
    await lands("invoice-link");
    await page.goForward();
    await expect(page).toHaveURL(/#edit-details$/);
    await lands("edit-details");

    // The header's Edit details link, clicked again after its section was collapsed (the same hash: no hashchange).
    const details = page.locator("#details");
    await details.locator(":scope > summary").click();
    await expect(details).not.toHaveAttribute("open", "");
    await page.getByRole("link", { name: "Edit details" }).click();
    await lands("edit-details");

    // Unsaved edits: neither the form nor the section around it can be collapsed, and other anchors never close them.
    const edit = page.locator("#edit-details");
    await edit.getByLabel("Venue name").fill("Typed, not saved");
    await details.locator(":scope > summary").click();
    await expect(details).toHaveAttribute("open", "");
    await expect(edit).toHaveAttribute("open", "");
    await page.evaluate(() => { window.location.hash = "#manage"; });
    await lands("manage");
    await page.goBack();
    await expect(edit).toHaveAttribute("open", "");
    await expect(edit.getByLabel("Venue name")).toHaveValue("Typed, not saved");
    // Closed without navigating: the unsaved-changes guard would hold a navigation.
    await page.context().close();
  });

  test("every state fits from 320px to 1920px; page actions are touch-sized; keyboard focus stays clear of the header", async () => {
    test.setTimeout(240_000);
    const keys = ["new", "draft", "sent", "submitted", "approved", "csent", "deposit", "booked", "passed", "external", "archived", "revised"];
    for (const width of [320, 430, 1024, 1280, 1920]) {
      const phone = width < 640;
      const context = await browser.newContext(phone ? { ...PHONE, viewport: { width, height: 844 } } : { viewport: { width, height: 1000 } });
      const page = await context.newPage();
      await signInStaff(page, tenant.ownerEmail);
      for (const key of keys) {
        const at = `${key} at ${width}`;
        await page.goto(`/staff/${tenant.slug}/events/${ev[key].id}`);
        await expect(page.getByTestId("next-action"), at).toBeVisible();
        expect(await sideways(page), at).toBeLessThanOrEqual(0);
        // Two columns only from xl (1280px): below it the supporting sections stack under the work.
        const main = (await page.getByTestId("workspace-main").boundingBox())!;
        const side = (await page.getByTestId("workspace-secondary").boundingBox())!;
        expect(side.x > main.x + main.width - 1, at).toBe(width >= 1280);
        if (phone) {
          // The page's actions, rows and its forms' buttons, fields and selects are at least 44px tall.
          const small = await page.evaluate(() =>
            [...document.querySelectorAll("[data-testid=workspace] :is(summary, [data-slot=link-row], [data-slot=button], [data-slot=input], select), [data-testid^=next-action-], a[href='#edit-details']")]
              .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44)
              .map((e) => `${(e.textContent ?? "").trim().slice(0, 30)}: ${e.getBoundingClientRect().height}`),
          );
          expect(small, at).toEqual([]);
        }
      }
      if (width === 320 || width === 1280) {
        // Tab through the booked page: focus never ends up under the sticky header.
        await page.goto(`/staff/${tenant.slug}/events/${ev.booked.id}`);
        await page.locator("main h1").click();
        for (let i = 0; i < 80; i++) {
          await page.keyboard.press("Tab");
          const f = await page.evaluate(() => {
            const e = document.activeElement as HTMLElement;
            const header = document.querySelector("[data-testid=navigation-progress]")!.getBoundingClientRect().bottom;
            return { inMain: Boolean(e.closest("main")), top: e.getBoundingClientRect().top, header, what: (e.textContent ?? "").trim().slice(0, 30) };
          });
          if (f.inMain) expect(f.top, `${f.what} at ${width}`).toBeGreaterThanOrEqual(f.header - 1);
        }
      }
      await context.close();
    }
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
