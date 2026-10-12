/**
 * Everyday client and event management in real browsers, in dedicated test
 * businesses: a client without a phone (proposals need none), the honest
 * phone hint, the contract step that explains a missing phone and fixes it
 * in place, international numbers, duplicate emails, lost updates, email
 * changes that already have access, phone search and sorting, the client
 * page's events and "New event", the searchable client picker, event
 * filters and orders, derived statuses (a signed contract still awaiting the
 * deposit is not "Booked"), stale contract drafts, archived events, another
 * business, a removed staff member, a suspended workspace and 320px
 * layouts. Events reach each state through the database functions the app
 * calls (as event-workspace-flow.spec.ts does). The list rules themselves are
 * tested in pgTAP (49_client_event_lists).
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, signInStaff } from "./support";
import { must, sessionFor } from "./booking";
import { archiveTestTenant, createTestTenant, publishContractTemplate, submitAsClient, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";

const run = randomUUID().slice(0, 6);
const NARROW = { viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true };
const DAY = 86_400_000;
const dateIn = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * DAY));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const STAGES = ["new", "draft", "sent", "submitted", "approved", "contract_draft", "contract_sent", "signed"] as const;
type Stage = (typeof STAGES)[number];
const reached = (upTo: Stage, stage: Stage) => STAGES.indexOf(upTo) >= STAGES.indexOf(stage);

type Ev = { id: string; clientId: string; clientEmail: string; proposalId?: string; approvalId?: string; contractId?: string; linkId?: string };

test.describe.serial("client and event management", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  let staffDb: SupabaseClient;
  let page: Page;
  let versionId = "";
  const ev: Record<string, Ev> = {};

  /** An event with its own primary contact and signer, taken to `upTo` through the app's database functions. */
  async function stage(key: string, title: string, upTo: Stage, opts: { phone?: string | null; type?: string; days?: number; venue?: string } = {}) {
    const id = randomUUID();
    const clientId = randomUUID();
    const clientEmail = `e2e-cem-${key}-${run}@example.test`;
    await must(admin.from("events").insert({ id, tenant_id: tenant.id, title, event_type: opts.type ?? "wedding", event_date: dateIn(opts.days ?? 60), timezone: "America/Toronto", venue_name: opts.venue ?? null }));
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: `Client ${key}`, email: clientEmail, phone: opts.phone === undefined ? "514 555-0123" : opts.phone }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: id, client_id: clientId, is_primary: true, can_sign: true }));
    ev[key] = { id, clientId, clientEmail };
    if (!reached(upTo, "draft")) return;
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
    const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: id, p_offer: input }));
    ev[key].proposalId = proposalId as string;
    if (!reached(upTo, "sent")) return;
    const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
    await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
    if (!reached(upTo, "submitted")) return;
    await submitAsClient(tenant, proposalId as string);
    if (!reached(upTo, "approved")) return;
    const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).not("submitted_at", "is", null).single());
    const { data: approval } = await must(staffDb.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));
    ev[key].approvalId = (approval as { approval_id: string }).approval_id;
    if (!reached(upTo, "contract_draft")) return;
    const { data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: ev[key].approvalId, p_template_version_id: versionId }));
    expect((generated as { status: string }).status).toBe("created");
    const contractId = (generated as { contract_id: string }).contract_id;
    ev[key].contractId = contractId;
    if (!reached(upTo, "contract_sent")) return;
    const linkId = randomUUID();
    ev[key].linkId = linkId;
    await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
    if (!reached(upTo, "signed")) return;
    const { data: user } = await must(admin.auth.admin.createUser({ email: clientEmail, email_confirm: true }));
    const clientDb = await sessionFor(clientEmail);
    await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
    const { data: c } = await must(admin.from("contracts").select("content_sha256, consent_version").eq("id", contractId).single());
    const path = `${tenant.id}/${contractId}/${randomUUID()}.png`;
    await must(admin.storage.from("contract-signatures").upload(path, PNG, { contentType: "image/png" }));
    await must(admin.rpc("sign_contract", {
      p_contract_id: contractId, p_tenant_slug: tenant.slug, p_user_id: user.user!.id, p_typed_name: `Client ${key}`,
      p_content_sha256: c!.content_sha256, p_consent_version: c!.consent_version, p_consent_accepted: true, p_signature_path: path,
      p_signature_sha256: createHash("sha256").update(PNG).digest("hex"), p_signature_bytes: PNG.length, p_signature_width: 1, p_signature_height: 1,
      p_user_agent: "E2E", p_client_ip: null, p_client_ip_source: "unavailable",
    }));
    // No PDF needed here; this contract's own job is retired so no other spec waits behind it.
    const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
    for (const j of (jobs ?? []) as { job_id: string; lease_token: string }[]) {
      await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "client-event e2e: PDF not needed", p_permanent: true });
    }
  }

  test.beforeAll(async ({ browser: b }) => {
    test.setTimeout(240_000);
    browser = b;
    tenant = await createTestTenant("cem", { catalog: true });
    other = await createTestTenant("cem-other");
    staffDb = await sessionFor(tenant.ownerEmail);
    // The business's template prints the client's phone, as the starter template does.
    versionId = await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Parties", body: "Client: {{client.name}}, {{client.email}}, {{client.phone}}" },
      { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
    ]);
    await stage("sentnophone", "No phone, proposal sent", "sent", { phone: null, days: 30 });
    await stage("nophone", "No phone, approved", "approved", { phone: null, days: 40 });
    await stage("cdraft", "Contract draft gala", "contract_draft", { type: "corporate", days: 50, venue: "Le Windsor" });
    await stage("csent", "Contract sent wedding", "contract_sent", { days: 70 });
    await stage("deposit", "Signed, deposit due", "signed", { days: 80 });
    await stage("archived", "Archived approved", "approved", { days: 90 });
    await stage("fresh", "Fresh enquiry", "new", { days: 95 });
    await stage("signedx", "Signed, email changes later", "signed", { days: 85 });
    await must(staffDb.rpc("set_event_archived", { p_event_id: ev.archived.id, p_archived: true }));
    page = await (await browser.newContext()).newPage();
    await signInStaff(page, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("a client without a phone: honest hint, international numbers, helpful errors, duplicate emails", async () => {
    await page.goto(`/staff/${tenant.slug}/clients`);
    await page.getByRole("link", { name: "Add client" }).first().click();
    const form = page.locator("#add-client");
    await expect(form.getByText("Optional for now. Your contract template includes the client's phone")).toBeVisible();
    await form.getByLabel("Name").fill(`Alex Martin ${run}`);
    await form.getByLabel("Email").fill(`alex-${run}@example.test`);
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByText(`Added Alex Martin ${run}.`)).toBeVisible();
    expect((await must(admin.from("clients").select("phone").eq("tenant_id", tenant.id).eq("email", `alex-${run}@example.test`).single())).data!.phone).toBeNull();

    // A typo'd number is explained; typed values stay.
    await form.getByLabel("Name").fill(`Camille Roy ${run}`);
    await form.getByLabel("Email").fill(`camille-${run}@example.test`);
    await form.getByLabel("Phone (optional)").fill("call me");
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByRole("alert")).toContainText("Use digits, spaces, brackets");
    await expect(form.getByLabel("Name")).toHaveValue(`Camille Roy ${run}`);
    await form.getByLabel("Phone (optional)").fill("+33 1 23 45 67 89");
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByText(`Added Camille Roy ${run}.`)).toBeVisible();
    expect((await must(admin.from("clients").select("phone").eq("tenant_id", tenant.id).eq("email", `camille-${run}@example.test`).single())).data!.phone).toBe("+33 1 23 45 67 89");

    // The same email again: a gentle warning with the existing client, never a silent duplicate or a merge.
    await form.getByLabel("Name").fill(`Alex M. ${run}`);
    await form.getByLabel("Email").fill(`ALEX-${run}@example.test`);
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByRole("alert")).toContainText(`Alex Martin ${run} already uses alex-${run}@example.test`);
    await expect(form.getByRole("link", { name: "Open existing client" })).toHaveAttribute("href", /\/clients\/[0-9a-f-]{36}$/);
    expect((await must(admin.from("clients").select("id").eq("tenant_id", tenant.id).ilike("email", `alex-${run}@example.test`))).data).toHaveLength(1);
    await form.getByLabel(/Save anyway as a separate client/).check();
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByText(`Added Alex M. ${run}.`)).toBeVisible();
    expect((await must(admin.from("clients").select("id").eq("tenant_id", tenant.id).ilike("email", `alex-${run}@example.test`))).data).toHaveLength(2);
    // Another business's identical email is never mentioned.
    await must(admin.from("clients").insert({ tenant_id: other.id, name: "Other DJ's client", email: `shared-${run}@example.test` }));
    await form.getByLabel("Name").fill(`Shared ${run}`);
    await form.getByLabel("Email").fill(`shared-${run}@example.test`);
    await form.getByRole("button", { name: "Add client" }).click();
    await expect(form.getByText(`Added Shared ${run}.`)).toBeVisible();
  });

  test("clients list: phone search by digits, recently added first, event counts", async () => {
    const base = `/staff/${tenant.slug}/clients`;
    await page.goto(`${base}?q=${encodeURIComponent("33123456")}`);
    await expect(page.getByTestId("client-row")).toHaveCount(1);
    await expect(page.getByTestId("client-row")).toContainText(`Camille Roy ${run}`);
    await page.goto(`${base}?q=5145550123`);
    await expect(page.getByTestId("client-row").first()).toContainText("514 555-0123");
    await page.goto(base);
    await page.getByLabel("Sort").selectOption("recent");
    await expect(page).toHaveURL(/sort=recent/);
    await expect(page.getByTestId("client-row").first()).toContainText(`Shared ${run}`);
    await expect(page.getByTestId("list-result")).toContainText("newest first");
    await page.getByLabel("Sort").selectOption("name");
    await expect(page).not.toHaveURL(/sort=/);
    await expect(page.getByTestId("client-row").filter({ hasText: "Client deposit" }).getByTestId("event-count")).toHaveText("1 event");
    await expect(page.getByTestId("client-row").filter({ hasText: `Camille Roy ${run}` }).getByTestId("event-count")).toHaveText("No events yet");
    await page.goto(`${base}?q=nobody-${run}`);
    await expect(page.getByTestId("clients-no-results")).toContainText("Search covers names, emails and phone numbers");
  });

  test("client page: events with their real status, then a new event for the same client", async () => {
    await page.goto(`/staff/${tenant.slug}/clients/${ev.deposit.clientId}`);
    await expect(page.getByTestId("client-upcoming").getByTestId("event-status")).toHaveText("Signed · awaiting deposit");
    await page.goto(`/staff/${tenant.slug}/clients/${ev.sentnophone.clientId}`);
    await expect(page.getByTestId("client-upcoming").getByTestId("event-status")).toHaveText("Proposal sent");
    await expect(page.getByText("No phone number")).toBeVisible();
    await expect(page.getByTestId("phone-needed")).toContainText("Needed before generating a contract");

    await page.getByTestId("new-event-for-client").click();
    await expect(page).toHaveURL(new RegExp(`/events/new\\?client=${ev.sentnophone.clientId}$`));
    await expect(page.getByTestId("picked-client")).toContainText("Client sentnophone");
    await page.getByLabel("Title").fill(`Second event ${run}`);
    await page.getByLabel("Date").fill(dateIn(120));
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page.getByRole("heading", { name: `Second event ${run}` })).toBeVisible();
    await expect(page.locator("#contacts")).toContainText("Client sentnophone");
    await expect(page.getByTestId("event-header-status")).toHaveText("New inquiry");
    // Only one client record: chosen, not duplicated.
    expect((await must(admin.from("clients").select("id").eq("tenant_id", tenant.id).eq("email", ev.sentnophone.clientEmail))).data).toHaveLength(1);
  });

  test("new event: find an existing client by search, or add one; nothing extra is required", async () => {
    await page.goto(`/staff/${tenant.slug}/events/new`);
    const picker = page.getByTestId("client-picker");
    await picker.getByLabel("Client", { exact: true }).fill("camille");
    await expect(picker.getByRole("button", { name: new RegExp(`Camille Roy ${run}`) })).toBeVisible();
    // Enter picks the single match instead of submitting the form.
    await picker.getByLabel("Client", { exact: true }).press("Enter");
    await expect(page.getByTestId("picked-client")).toContainText("+33 1 23 45 67 89");
    await page.getByRole("button", { name: "Change" }).click();
    await expect(picker.getByLabel("Client", { exact: true })).toBeFocused();
    await page.getByLabel("New client").check();
    await page.getByLabel("Name", { exact: true }).fill(`Jo Lee ${run}`);
    await page.getByLabel("Email").fill(`camille-${run}@example.test`);
    await page.getByLabel("Title").fill(`Jo's party ${run}`);
    await page.getByLabel("Date").fill(dateIn(100));
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page.locator("form").getByRole("alert")).toContainText(`Camille Roy ${run} already uses camille-${run}@example.test. Choose them under “Existing client”`);
    await expect(page.getByLabel("Title")).toHaveValue(`Jo's party ${run}`);
    await page.getByLabel(/Create a separate client/).check();
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page.getByRole("heading", { name: `Jo's party ${run}` })).toBeVisible();
  });

  test("proposals need no phone; the contract step says so early and fixes it in place", async () => {
    // A proposal was sent to a client without a phone (stage "sent" above): nothing blocks it.
    await page.goto(`/staff/${tenant.slug}/events/${ev.sentnophone.id}`);
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-key", "awaiting_selection");
    await expect(page.getByTestId("next-action")).not.toContainText("phone");
    await expect(page.getByTestId("overview-contract")).toContainText("Client phone number needed before generating the contract");
    await expect(page.getByTestId("signer-phone-needed")).toBeVisible();

    // Approved, signer without a phone: the blocker names it and points at the fix.
    const eventUrl = `/staff/${tenant.slug}/events/${ev.nophone.id}`;
    await page.goto(eventUrl);
    const next = page.getByTestId("next-action");
    await expect(next).toHaveAttribute("data-key", "prepare_contract");
    await expect(next).toContainText("Client nophone, the signer, has no phone number, and your contract template includes the client's phone.");
    await expect(page.getByTestId("next-action-primary")).toHaveCount(0);
    await expect(page.getByTestId("overview-contract")).toContainText("Phone number needed");
    await next.getByRole("link", { name: "Add phone number" }).click();
    const fix = page.getByTestId("contract-phone-needed");
    await expect(fix).toBeVisible();
    await fix.getByLabel("Phone number for Client nophone").fill("12345");
    await fix.getByRole("button", { name: "Save phone number" }).click();
    await expect(fix.getByRole("alert")).toContainText("7 to 20 digits");
    await fix.getByLabel("Phone number for Client nophone").fill("+1 (438) 555-0199 ext. 4");
    await fix.getByRole("button", { name: "Save phone number" }).click();
    await expect(page.getByText("Phone number saved. You can generate the draft now.")).toBeVisible();
    await expect(page.getByTestId("contract-phone-needed")).toHaveCount(0);
    expect((await must(admin.from("clients").select("phone").eq("id", ev.nophone.clientId).single())).data!.phone).toBe("+1 (438) 555-0199 ext. 4");
    await page.getByRole("button", { name: "Generate contract draft" }).click();
    await page.waitForURL("**/contracts/**");
    await expect(page.getByText("+1 (438) 555-0199 ext. 4")).toBeVisible();
  });

  test("an event edited after its contract draft: explained, never silently rewritten", async () => {
    const before = (await must(admin.from("contracts").select("content_sha256, party_snapshot").eq("id", ev.cdraft.contractId!).single())).data!;
    await page.goto(`/staff/${tenant.slug}/events/${ev.cdraft.id}#edit-details`);
    await expect(page.getByTestId("edit-effect")).toContainText("Sent proposals, the approved selection and contracts keep the details they were created with");
    await page.getByLabel("Venue name").fill("Château Example");
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-key", "contract_outdated");
    await expect(page.getByTestId("next-action")).toContainText("The venue changed after this draft was generated");
    await expect(page.locator("#contract").getByTestId("contract-changes")).toContainText("venue");
    const after = (await must(admin.from("contracts").select("content_sha256, party_snapshot").eq("id", ev.cdraft.contractId!).single())).data!;
    expect(after).toEqual(before);
    await page.goto(`/staff/${tenant.slug}/contracts/${ev.cdraft.contractId}/review`);
    await expect(page.getByTestId("contract-changes")).toContainText("This draft still shows the earlier details");
  });

  test("a stale event form can't overwrite newer details", async () => {
    await page.goto(`/staff/${tenant.slug}/events/${ev.cdraft.id}#edit-details`);
    await must(admin.from("events").update({ venue_address: "1 Elsewhere" }).eq("id", ev.cdraft.id));
    await page.getByLabel("Title").fill("Overwritten title");
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Someone else changed this event's details");
    expect((await must(admin.from("events").select("title, venue_address").eq("id", ev.cdraft.id).single())).data).toEqual({ title: "Contract draft gala", venue_address: "1 Elsewhere" });
  });

  test("editing a client: lost updates refused; an email with access asks first and moves nothing", async () => {
    const clientUrl = `/staff/${tenant.slug}/clients/${ev.csent.clientId}`;
    await page.goto(clientUrl);
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByTestId("email-change-note")).toBeVisible();
    // Someone else saves first.
    await must(admin.from("clients").update({ name: "Client csent (renamed elsewhere)" }).eq("id", ev.csent.clientId));
    await page.getByLabel("Phone (optional)").fill("514 555 0177");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Someone else changed this client's details");
    expect((await must(admin.from("clients").select("phone").eq("id", ev.csent.clientId).single())).data!.phone).toBe("514 555-0123");

    await page.reload();
    const frozen = (await must(admin.from("contracts").select("signer_email, content_sha256, party_snapshot, status").eq("id", ev.csent.contractId!).single())).data!;
    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Email").fill(`new-csent-${run}@example.test`);
    await page.getByRole("button", { name: "Save details" }).click();
    const alert = page.locator("#details").getByRole("alert");
    await expect(alert).toContainText("Changing the contact email doesn't revoke or move anything already sent.");
    await expect(alert).toContainText(`The signer of the contract already sent stays ${ev.csent.clientEmail}`);
    expect((await must(admin.from("clients").select("email").eq("id", ev.csent.clientId).single())).data!.email).toBe(ev.csent.clientEmail);
    await page.getByLabel(/Change the email to/).check();
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByText("Contact details saved.").filter({ visible: true })).toBeVisible();
    expect((await must(admin.from("clients").select("email").eq("id", ev.csent.clientId).single())).data!.email).toBe(`new-csent-${run}@example.test`);
    // The sent contract still names the old address and is unchanged; resending now needs a new contract.
    expect((await must(admin.from("contracts").select("signer_email, content_sha256, party_snapshot, status").eq("id", ev.csent.contractId!).single())).data).toEqual(frozen);
    const { data: review } = await must(staffDb.rpc("review_contract_for_send", { p_contract_id: ev.csent.contractId }));
    expect((review as { problems: { code: string }[] }).problems.map((p) => p.code)).toContain("signer_changed");
  });

  test("events list: type, date range and order filters; statuses from the records", async () => {
    const base = `/staff/${tenant.slug}/events`;
    await page.goto(base);
    const row = (title: string) => page.getByTestId("event-row").filter({ hasText: title });
    await expect(row("No phone, proposal sent").getByTestId("event-status")).toHaveText("Proposal sent");
    await expect(row("Contract sent wedding").getByTestId("event-status")).toHaveText("Contract sent");
    await expect(row("Signed, deposit due").getByTestId("event-status")).toHaveText("Signed · awaiting deposit");
    await expect(row("Contract draft gala")).toContainText("Corporate");
    await expect(page.getByText("More filters")).toBeVisible();
    await expect(page.getByLabel("Type")).toBeHidden();

    await page.getByText("More filters").click();
    await page.getByLabel("Type").selectOption("corporate");
    await expect(page).toHaveURL(/type=corporate/);
    await expect(page.getByTestId("event-row")).toHaveCount(1);
    await expect(page.getByTestId("list-result")).toContainText("1 upcoming corporate event");

    await page.goto(`${base}?from=${dateIn(35)}&to=${dateIn(75)}`);
    await expect(page.getByLabel("From")).toBeVisible();
    await expect(page.getByTestId("event-row")).toHaveCount(3);
    await expect(page.getByTestId("event-row").first()).toContainText("No phone, approved");

    await page.goto(`${base}?sort=created`);
    await expect(page.getByTestId("event-row").first()).toContainText(`Jo's party ${run}`);
    await expect(page.getByTestId("list-result")).toContainText("newest first");
    await page.goto(`${base}?q=${encodeURIComponent(`new-csent-${run}`)}`);
    await expect(page.getByTestId("event-row")).toHaveCount(1);
    await page.goto(`${base}?view=past&from=${dateIn(35)}`);
    await expect(page.getByTestId("events-no-results").getByRole("link", { name: "Search all dates in this range" })).toBeVisible();
  });

  test("a signed contract with the deposit still due isn't booked; archived events offer no next steps", async () => {
    await page.goto(`/staff/${tenant.slug}/events/${ev.deposit.id}`);
    await expect(page.getByTestId("event-header-status")).toHaveText("Signed · awaiting deposit");
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-key", "record_payment");

    await page.goto(`/staff/${tenant.slug}/events/${ev.archived.id}`);
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-key", "archived");
    await expect(page.getByTestId("next-action-primary")).toHaveCount(0);
    await expect(page.getByTestId("event-when")).toHaveCount(0);
  });

  test("changing a client's email is audited and never moves existing access or rewrites documents", async () => {
    const slug = tenant.slug;
    /** Saves a new email as the client editor does: only the version just read. */
    const change = async (clientId: string, email: string) => {
      const { data: c } = await must(staffDb.from("clients").select("updated_at").eq("id", clientId).single());
      const { data } = await must(staffDb.from("clients").update({ email }).eq("id", clientId).eq("updated_at", c!.updated_at).select("id"));
      expect(data).toHaveLength(1);
    };
    const audits = async (clientId: string) =>
      (await must(admin.from("audit_events").select("actor_type, metadata").eq("entity_id", clientId).eq("action", "client_email_changed"))).data!;
    const newClient = async (email: string) => {
      await must(admin.auth.admin.createUser({ email, email_confirm: true }));
      return sessionFor(email);
    };

    // Before any proposal: audited; the next proposal goes to the new address through the normal send.
    const freshEmail = `fresh-new-${run}@example.test`;
    await change(ev.fresh.clientId, freshEmail);
    const freshAudit = await audits(ev.fresh.clientId);
    expect(freshAudit).toHaveLength(1);
    expect(freshAudit[0].actor_type).toBe("staff");
    expect(JSON.stringify(freshAudit[0].metadata)).not.toContain("@");
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
    const { data: freshProposal } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: ev.fresh.id, p_offer: input }));
    await must(staffDb.rpc("send_proposal", { p_proposal_id: freshProposal, p_expected_draft_version: 0, p_access_link_id: randomUUID(), p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
    const { data: outbox } = await must(admin.from("email_outbox").select("recipient_email").eq("tenant_id", tenant.id).eq("entity_id", freshProposal as string));
    expect(outbox!.map((o) => o.recipient_email)).toEqual([freshEmail]);

    // After a proposal was sent: its link is untouched and keeps working exactly as before.
    const linkCols = "id, token_hash, intended_client_id, revoked_at, expires_at";
    const { data: linksBefore } = await must(admin.from("access_links").select(linkCols).eq("proposal_id", ev.sentnophone.proposalId!));
    await change(ev.sentnophone.clientId, `sent-new-${run}@example.test`);
    const { data: linksAfter } = await must(admin.from("access_links").select(linkCols).eq("proposal_id", ev.sentnophone.proposalId!));
    expect(linksAfter).toEqual(linksBefore);
    await must(admin.rpc("exchange_proposal_link", { p_token_hash: linksBefore![0].token_hash, p_session_hash: createHash("sha256").update(randomUUID()).digest("hex"), p_tenant_slug: slug, p_session_seconds: 60 }));

    // After a contract was sent (its client's email was changed earlier): the new address can't take over the invitation.
    const csentNew = await newClient(`new-csent-${run}@example.test`);
    const { data: status } = await must(csentNew.rpc("client_invitation_status", { p_link_id: ev.csent.linkId, p_tenant_slug: slug }));
    expect((status as { state: string }).state).toBe("wrong_account");
    const { data: accepted } = await must(csentNew.rpc("accept_contract_invitation", { p_link_id: ev.csent.linkId, p_tenant_slug: slug }));
    expect((accepted as { state: string }).state).toBe("wrong_account");
    expect((await must(admin.from("event_access").select("id").eq("event_id", ev.csent.id))).data).toHaveLength(0);

    // After signing: the signer, signature and documents are frozen; the old address keeps only what it had.
    const contractId = ev.signedx.contractId!;
    const frozen = async () => ({
      contract: (await must(admin.from("contracts").select("signer_client_id, signer_email, signer_name, content_sha256, party_snapshot, status, signed_at").eq("id", contractId).single())).data,
      signatures: (await must(admin.from("contract_signatures").select("*").eq("contract_id", contractId))).data,
      documents: (await must(admin.from("contract_documents").select("*").eq("contract_id", contractId))).data,
      access: (await must(admin.from("event_access").select("user_id, client_id, revoked_at").eq("event_id", ev.signedx.id))).data,
    });
    const before = await frozen();
    expect(before.signatures).toHaveLength(1);
    await change(ev.signedx.clientId, `signedx-new-${run}@example.test`);
    expect(await frozen()).toEqual(before);
    const oldDb = await sessionFor(ev.signedx.clientEmail);
    expect(JSON.stringify((await must(oldDb.rpc("my_contracts"))).data)).toContain(contractId);
    const newDb = await newClient(`signedx-new-${run}@example.test`);
    expect((await must(newDb.rpc("my_contracts"))).data ?? []).toEqual([]);
    expect((await must(newDb.rpc("my_events"))).data ?? []).toEqual([]);
    const view = await must(newDb.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: slug }));
    expect(view.data).toEqual({ state: "unavailable" });
    const plan = await must(newDb.rpc("client_planning_view", { p_event_id: ev.signedx.id, p_tenant_slug: slug }));
    expect(plan.data).toEqual({ state: "unavailable" });
    // The old address still reads its own signed contract.
    expect(((await must(oldDb.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: slug }))).data as { state: string }).state).toBe("available");
    // The old address's access stays on its own event: nothing on another event or business.
    expect(JSON.stringify((await must(oldDb.rpc("my_events"))).data)).not.toContain(ev.deposit.id);
    expect(await audits(ev.signedx.clientId)).toHaveLength(1);
  });

  test("another business, a removed staff member and a suspended workspace get nothing", async () => {
    // Another business's owner.
    const outsider = await (await browser.newContext()).newPage();
    await signInStaff(outsider, other.ownerEmail);
    for (const path of [`/clients/${ev.csent.clientId}`, `/events/${ev.csent.id}`, `/clients?q=csent`]) {
      await outsider.goto(`/staff/${tenant.slug}${path}`);
      await expect(outsider.getByRole("heading", { name: "Page not found" })).toBeVisible();
    }
    // The picker's search only ever sees the signed-in business: another business's clients never appear.
    await outsider.goto(`/staff/${other.slug}/events/new`);
    await outsider.getByLabel("Existing client").check();
    await outsider.getByTestId("client-picker").getByLabel("Client", { exact: true }).fill("Client csent");
    await expect(outsider.getByTestId("client-picker")).toContainText("No active client matches");

    // A staff member, then removed.
    const staffEmail = `e2e-cem-staff-${run}@example.test`;
    const { data: user } = await must(admin.auth.admin.createUser({ email: staffEmail, email_confirm: true }));
    const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
    await must(admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: user.user!.id, role: "staff" }));
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${tenant.slug}/clients/${ev.csent.clientId}`);
    await expect(staff.getByRole("heading", { name: "Client csent (renamed elsewhere)" })).toBeVisible();
    await must(admin.from("tenant_memberships").update({ removed_at: new Date().toISOString(), removed_by: owner!.user_id }).eq("tenant_id", tenant.id).eq("user_id", user.user!.id));
    await staff.goto(`/staff/${tenant.slug}/clients/${ev.csent.clientId}`);
    await expect(staff.getByText("Client csent (renamed elsewhere)")).toHaveCount(0);
    await staff.context().close();

    // A suspended workspace (the other business): its own owner is turned away.
    suspendLocally(other.id);
    await outsider.goto(`/staff/${other.slug}/clients`);
    await expect(outsider).toHaveURL(/\/unavailable/);
    await outsider.context().close();
  });

  test("at 320px: nothing scrolls sideways, filters fold away, the picker and contract fix fit", async () => {
    const narrow = await (await browser.newContext(NARROW)).newPage();
    await signInStaff(narrow, tenant.ownerEmail);
    for (const path of ["/clients", `/clients/${ev.csent.clientId}`, "/events", "/events/new", `/events/${ev.nophone.id}`, `/events/${ev.sentnophone.id}`]) {
      await narrow.goto(`/staff/${tenant.slug}${path}`);
      await expect(narrow.locator("h1")).toBeVisible();
      expect(await sideways(narrow), path).toBeLessThanOrEqual(0);
    }
    await narrow.goto(`/staff/${tenant.slug}/events`);
    await expect(narrow.getByLabel("Type")).toBeHidden();
    await expect(narrow.getByRole("searchbox")).toBeVisible();
    await narrow.goto(`/staff/${tenant.slug}/events/new`);
    const picker = narrow.getByTestId("client-picker");
    await picker.getByLabel("Client", { exact: true }).fill("Client");
    const option = picker.getByRole("button").first();
    const box = await option.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await sideways(narrow)).toBeLessThanOrEqual(0);
    await narrow.context().close();
  });
});
