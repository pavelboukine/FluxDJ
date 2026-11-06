/**
 * Configurable booking workflows in real browsers against local Supabase, from the
 * Create event form to client planning. Dedicated test business:
 *   - contract-first with no pricing: an owner generates, sends; the client signs; booked at once; planning opens;
 *   - contract-first with a deposit: the amount is suggested, partial payment doesn't book, the deposit does;
 *   - the default stays the full workflow, and the proposal can be turned off until something starts.
 * The event booked elsewhere is covered by external-booking-flow.spec.ts, and the full proposal path by contract-flow.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { must, sessionFor } from "./booking";
import { admin, signInStaff, verifyContractInvitation, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const BASE = "http://127.0.0.1:3000";

test.describe.configure({ mode: "serial" });

test.describe("booking workflows", () => {
  const run = randomUUID().slice(0, 6);
  let tenant: TestTenant;
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  const clientContexts: BrowserContext[] = [];

  async function publishForClientUse(name: string, title: string, sections: { heading: string; body: string }[]) {
    const db = await sessionFor(tenant.ownerEmail);
    const { data: templateId } = await must(db.rpc("create_contract_template", { p_tenant_id: tenant.id, p_name: name, p_title: title, p_sections: sections }));
    const { data: version } = await must(db.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    const { data: statement } = await must(db.rpc("client_use_statement_current"));
    await must(db.rpc("publish_contract_template_version", { p_version_id: version!.id, p_expected_draft_version: 0, p_usage: "client_use", p_client_use_statement_version: (statement as { version: string }).version }));
    return version!.id;
  }

  async function createEvent(page: Page, opts: { title: string; clientName: string; clientEmail: string; proposal: boolean }) {
    await page.goto(`/staff/${tenant.slug}/events/new`);
    await page.getByLabel("New client").check();
    await page.getByLabel("Name", { exact: true }).fill(opts.clientName);
    await page.getByLabel("Email", { exact: true }).fill(opts.clientEmail);
    const steps = page.getByTestId("booking-source");
    await expect(steps.getByRole("radio", { name: /Book through Flux DJ/ })).toBeChecked();
    await expect(steps.getByRole("checkbox", { name: /Send a proposal first/ })).toBeChecked();
    if (!opts.proposal) await steps.getByRole("checkbox", { name: /Send a proposal first/ }).uncheck();
    await page.getByLabel("Title", { exact: true }).fill(opts.title);
    await page.getByLabel("Date", { exact: true }).fill("2027-08-28");
    await page.getByRole("button", { name: "Create event" }).click();
    await page.waitForURL(/\/events\/[0-9a-f-]{36}$/);
    return new URL(page.url()).pathname.split("/").pop()!;
  }

  /** Sends the draft staff just generated and opens it as the client, on a phone. */
  async function sendAndOpen(contractId: string, clientEmail: string) {
    await staff.goto(`/staff/${tenant.slug}/contracts/${contractId}/review`);
    await staff.getByRole("button", { name: "Send contract…" }).click();
    const sentAt = Date.now();
    await staff.getByRole("dialog", { name: "Confirm sending the contract" }).getByRole("button", { name: "Send contract now" }).click();
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
    const invite = new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    clientContexts.push(context);
    const client = await context.newPage();
    await verifyContractInvitation(client, invite, clientEmail);
    await client.getByRole("button", { name: "Open my contract" }).click();
    await client.waitForURL(new RegExp(`/${tenant.slug}/contracts/${contractId}$`));
    return { client, email };
  }

  async function signAs(client: Page, name: string) {
    await client.getByLabel("Your full name").fill(name);
    await client.getByTestId("signature-canvas").scrollIntoViewIfNeeded();
    const box = (await client.getByTestId("signature-canvas").boundingBox())!;
    await client.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.6);
    await client.mouse.down();
    for (let i = 1; i <= 30; i++) await client.mouse.move(box.x + box.width * (0.12 + 0.025 * i), box.y + box.height * (0.5 + 0.25 * Math.sin(i / 2.5)));
    await client.mouse.up();
    await client.getByRole("checkbox").check();
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await client.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
  }

  const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("workflows", { catalog: true });
    await must((await sessionFor(tenant.ownerEmail)).rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    for (const c of clientContexts) await c.close();
    await staffContext?.close();
    if (tenant) await archiveTestTenant(tenant);
  });

  test("the booking choice explains itself, keeps the proposal preference and works by keyboard", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/new`);
    const steps = staff.getByTestId("booking-source");
    const flux = steps.getByRole("radio", { name: /Book through Flux DJ/ });
    const elsewhere = steps.getByRole("radio", { name: /Already booked elsewhere/ });
    const proposal = steps.getByRole("checkbox", { name: /Send a proposal first/ });
    const flow = staff.getByRole("list", { name: "Booking steps for this event" });
    const help = staff.getByTestId("primary-contact-help");

    // The default is the full workflow.
    await expect(staff.getByRole("group", { name: "How is this event being booked?" })).toBeVisible();
    await expect(flux).toBeChecked();
    await expect(proposal).toBeChecked();
    await expect(flow.getByRole("listitem")).toHaveText(["1Proposal", "2Contract", "3Confirmation", "4Planning"]);
    await expect(help).toHaveText("This person will receive the proposal and sign the contract.");
    await expect(steps).not.toContainText(/deposit|contract_first/i);

    await proposal.uncheck();
    await expect(flow.getByRole("listitem")).toHaveText(["1Contract", "2Confirmation", "3Planning"]);
    await expect(help).toHaveText("This person will receive and sign the contract.");

    // The whole choice is clickable, and the preference survives the round trip.
    await steps.getByText("Skip proposals and contracts. Use Flux DJ for event planning.").click();
    await expect(elsewhere).toBeChecked();
    await expect(proposal).toHaveCount(0);
    await expect(flow).toHaveCount(0);
    await expect(help).toHaveText("This person will receive access to plan the event with you.");
    await steps.getByText("Send an agreement, confirm the booking, and plan the event.").click();
    await expect(flux).toBeChecked();
    await expect(proposal).not.toBeChecked();
    await expect(flow.getByRole("listitem")).toHaveText(["1Contract", "2Confirmation", "3Planning"]);

    // Keyboard: arrows move between the choices, and Space toggles the proposal.
    await proposal.check();
    await flux.focus();
    await staff.keyboard.press("ArrowDown");
    await expect(elsewhere).toBeChecked();
    await expect(elsewhere).toBeFocused();
    await staff.keyboard.press("ArrowUp");
    await expect(flux).toBeChecked();
    await expect(proposal).toBeChecked();
    await staff.keyboard.press("Tab");
    await expect(proposal).toBeFocused();
    await staff.keyboard.press("Space");
    await expect(proposal).not.toBeChecked();
  });

  for (const width of [320, 390]) {
    test(`the booking choice fits a ${width}px phone`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 800 }, storageState: await staffContext.storageState() });
      clientContexts.push(context);
      const page = await context.newPage();
      await page.goto(`/staff/${tenant.slug}/events/new`);
      const steps = page.getByTestId("booking-source");
      await expect(steps.getByRole("radio", { name: /Book through Flux DJ/ })).toBeChecked();
      expect(await noHorizontalScroll(page)).toBe(true);
      const heights = await steps.locator("label").evaluateAll((labels) => labels.map((l) => l.getBoundingClientRect().height));
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
      // Every step's label fits its own column, on one line.
      const steps4 = await page.getByTestId("booking-flow").locator("li > span:last-child").evaluateAll((labels) => labels.map((l) => ({ fits: l.scrollWidth <= (l.parentElement as HTMLElement).clientWidth, height: l.getBoundingClientRect().height })));
      expect(steps4).toHaveLength(4);
      for (const step of steps4) {
        expect(step.fits).toBe(true);
        expect(step.height).toBeLessThan(20);
      }
      await steps.getByRole("radio", { name: /Already booked elsewhere/ }).check();
      expect(await noHorizontalScroll(page)).toBe(true);
    });
  }

  test("each business's default sets where the checkbox starts, and nothing else", async () => {
    const proposal = (page: Page) => page.getByTestId("booking-source").getByRole("checkbox", { name: /Send a proposal first/ });
    const eventsBefore = (await must(admin.from("events").select("id, contract_first, booking_source").eq("tenant_id", tenant.id).order("id"))).data;

    // A second business keeps the default while this one changes it.
    const other = await createTestTenant("workflows-b", { catalog: true });
    const otherContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const otherPage = await otherContext.newPage();
      await signInStaff(otherPage, other.ownerEmail);

      // The owner turns it off in Settings, and it persists.
      await staff.goto(`/staff/${tenant.slug}/settings`);
      const card = staff.getByTestId("proposal-default");
      const setting = card.getByRole("checkbox", { name: "Send proposals by default" });
      await expect(setting).toBeChecked();
      await expect(card).toContainText("Start new events with the proposal step enabled. You can still change this for each event.");
      await setting.uncheck();
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText(/Saved\./)).toBeVisible();
      await staff.reload();
      await expect(staff.getByTestId("proposal-default").getByRole("checkbox", { name: "Send proposals by default" })).not.toBeChecked();

      // Existing events don't change.
      expect((await must(admin.from("events").select("id, contract_first, booking_source").eq("tenant_id", tenant.id).order("id"))).data).toEqual(eventsBefore);

      // The businesses start differently.
      await otherPage.goto(`/staff/${other.slug}/events/new`);
      await expect(proposal(otherPage)).toBeChecked();
      await staff.goto(`/staff/${tenant.slug}/events/new`);
      await expect(proposal(staff)).not.toBeChecked();
      await expect(staff.getByRole("list", { name: "Booking steps for this event" }).getByRole("listitem")).toHaveText(["1Contract", "2Confirmation", "3Planning"]);
      await expect(staff.getByTestId("primary-contact-help")).toHaveText("This person will receive and sign the contract.");

      // A manual choice survives switching, and isn't overwritten by the default.
      await proposal(staff).check();
      await staff.getByTestId("booking-source").getByRole("radio", { name: /Already booked elsewhere/ }).check();
      await staff.getByTestId("booking-source").getByRole("radio", { name: /Book through Flux DJ/ }).check();
      await expect(proposal(staff)).toBeChecked();
      await expect(staff.getByRole("list", { name: "Booking steps for this event" }).getByRole("listitem")).toHaveText(["1Proposal", "2Contract", "3Confirmation", "4Planning"]);

      // Left alone, the form creates a contract-first event.
      await staff.reload();
      await staff.getByLabel("New client").check();
      await staff.getByLabel("Name", { exact: true }).fill("Default Client");
      await staff.getByLabel("Email", { exact: true }).fill(`e2e-wf-default-${run}@example.test`);
      await staff.getByLabel("Title", { exact: true }).fill(`Default off ${run}`);
      await staff.getByLabel("Date", { exact: true }).fill("2027-08-28");
      await staff.getByRole("button", { name: "Create event" }).click();
      await staff.waitForURL(/\/events\/[0-9a-f-]{36}$/);
      const defaultId = new URL(staff.url()).pathname.split("/").pop()!;
      expect((await must(admin.from("events").select("booking_source, contract_first").eq("id", defaultId).single())).data).toEqual({ booking_source: "flux", contract_first: true });

      // Or a full-workflow one, once the proposal is switched back on.
      await staff.goto(`/staff/${tenant.slug}/events/new`);
      await proposal(staff).check();
      await staff.getByLabel("New client").check();
      await staff.getByLabel("Name", { exact: true }).fill("Manual Client");
      await staff.getByLabel("Email", { exact: true }).fill(`e2e-wf-manual-${run}@example.test`);
      await staff.getByLabel("Title", { exact: true }).fill(`Manual on ${run}`);
      await staff.getByLabel("Date", { exact: true }).fill("2027-08-28");
      await staff.getByRole("button", { name: "Create event" }).click();
      await staff.waitForURL(/\/events\/[0-9a-f-]{36}$/);
      const manualId = new URL(staff.url()).pathname.split("/").pop()!;
      expect((await must(admin.from("events").select("booking_source, contract_first").eq("id", manualId).single())).data).toEqual({ booking_source: "flux", contract_first: false });

      // A staff member sees it but can't change it, on the page or through the database.
      const staffEmail = `e2e-wf-default-staff-${run}@example.test`;
      const { data: user } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
      await must(admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: user.user!.id, role: "staff" }));
      const staffOnly = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      clientContexts.push(staffOnly);
      const staffPage = await staffOnly.newPage();
      await signInStaff(staffPage, staffEmail);
      await staffPage.goto(`/staff/${tenant.slug}/settings`);
      await expect(staffPage.getByTestId("proposal-default")).toContainText("Only the owner can change the default.");
      await expect(staffPage.getByTestId("proposal-default").getByRole("checkbox")).toHaveCount(0);
      const refused = await (await sessionFor(staffEmail)).rpc("update_proposal_default", { p_tenant_id: tenant.id, p_enabled: true });
      expect(refused.error?.code).toBe("42501");
    } finally {
      await otherContext.close();
      await archiveTestTenant(other);
      // The rest of this file expects the default.
      await must((await sessionFor(tenant.ownerEmail)).rpc("update_proposal_default", { p_tenant_id: tenant.id, p_enabled: true }));
    }
  });

  test("the default stays the full workflow, and the proposal can be turned off until something starts", async () => {
    const eventId = await createEvent(staff, { title: `Full ${run}`, clientName: "Full Client", clientEmail: `e2e-wf-full-${run}@example.test`, proposal: true });
    expect((await must(admin.from("events").select("booking_source, contract_first").eq("id", eventId).single())).data).toEqual({ booking_source: "flux", contract_first: false });
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "create_proposal");
    await expect(staff.locator("#proposal")).toBeVisible();

    await staff.getByTestId("booking-steps-switch").getByRole("button", { name: "Skip the proposal" }).click();
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "prepare_contract");
    await expect(staff.locator("#proposal")).toHaveCount(0);
    await staff.getByTestId("booking-steps-switch").getByRole("button", { name: "Add a proposal" }).click();
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "create_proposal");
    await staff.locator("#proposal").getByRole("button", { name: "Start proposal draft" }).click();
    await staff.waitForURL(/\/proposals\/[0-9a-f-]{36}/);
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("booking-steps-switch")).toHaveCount(0);
  });

  test("contract-first with no pricing: signed means booked, and planning follows", async () => {
    const clientEmail = `e2e-wf-none-${run}@example.test`;
    await publishForClientUse("Our agreement", `Agreement ${run} for {{event.title}}`, [{ heading: "Our terms", body: "Between {{business.legal_name}} and {{client.name}}. We agree to the event." }]);
    const eventId = await createEvent(staff, { title: `No money ${run}`, clientName: "Nora Client", clientEmail, proposal: false });
    expect((await must(admin.from("events").select("booking_source, contract_first").eq("id", eventId).single())).data).toEqual({ booking_source: "flux", contract_first: true });

    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "prepare_contract");
    await expect(staff.getByTestId("next-action")).toContainText("Prepare the contract");
    await expect(staff.locator("#proposal")).toHaveCount(0);
    await expect(staff.getByTestId("booking-source-note")).toContainText("No proposal");

    const card = staff.locator("#contract");
    await expect(card.getByTestId("direct-no-terms")).toBeVisible();
    await expect(card.getByTestId("direct-money")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Generate contract draft" })).toBeDisabled();
    await card.getByTestId("deposit-override").getByRole("checkbox").check();
    await card.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    const contractId = staff.url().split("/").pop()!;
    await expect(staff.getByTestId("contract-no-terms")).toBeVisible();

    const { client, email } = await sendAndOpen(contractId, clientEmail);
    expect(email.text).not.toMatch(/Deposit|0\.00/);
    await expect(client.getByText("We agree to the event.")).toBeVisible();
    await expect(client.locator("main")).not.toContainText(/Paid in full|No payment due|Total, including|Deposit on signing|0\.00/);
    await expect(client.locator("main")).toContainText("I have read the entire agreement shown above.");
    await expect(client.locator("main")).not.toContainText("including its payment terms");
    await signAs(client, "Nora Client");
    await expect(client.getByTestId("signed-outcome")).toHaveAttribute("data-state", "booked");
    expect(await noHorizontalScroll(client)).toBe(true);

    // As the consent statement says: a signed copy to download, and one emailed.
    await expect(async () => {
      await client.reload();
      await expect(client.getByRole("link", { name: "Download signed PDF" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    const head = await client.request.get(`/${tenant.slug}/contracts/${contractId}/signed-pdf`);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-type"]).toContain("application/pdf");
    await waitForEmail(clientEmail, { subject: /signed/i });

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("event-header-status")).toHaveText("Booked");
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "set_up_planning");
    await expect(staff.getByTestId("payments-no-terms")).toBeVisible();
    await expect(staff.getByTestId("payment-figures")).toHaveCount(0);
    await expect(staff.locator("main")).not.toContainText(/Paid in full/);
    expect((await must(admin.from("event_payments").select("id").eq("event_id", eventId))).data).toEqual([]);

    // Staff set up planning; the client who signed goes straight in, with no proposal link anywhere.
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning`);
    await staff.getByLabel("Template").selectOption({ label: "Wedding" });
    await staff.getByRole("button", { name: "Apply template" }).click();
    await expect(staff.getByText(/Template applied:/)).toBeVisible();
    await client.goto(`/${tenant.slug}/events/${eventId}`);
    await expect(client.getByTestId("hub-booking")).not.toContainText("Approved proposal");
    await client.goto(`/${tenant.slug}/events/${eventId}/planning`);
    await expect(client).toHaveURL(new RegExp(`/${tenant.slug}/events/${eventId}/planning`));
    await expect(client.locator("main")).not.toContainText(/setting up|isn't available/i);
    expect(await noHorizontalScroll(client)).toBe(true);
  });

  test("contract-first with a deposit: suggested, stated, and required before booking", async () => {
    const clientEmail = `e2e-wf-dep-${run}@example.test`;
    await publishForClientUse("Priced agreement", `Priced ${run} for {{event.title}}`, [{ heading: "Price", body: "Total: {{pricing.total}}. Deposit: {{payment.deposit}}. Balance: {{payment.balance}}." }]);
    const eventId = await createEvent(staff, { title: `Deposit ${run}`, clientName: "Dana Client", clientEmail, proposal: false });

    const card = staff.locator("#contract");
    await card.getByLabel("Template version").selectOption({ label: (await card.getByLabel("Template version").locator("option", { hasText: "Priced agreement" }).first().textContent())! });
    await card.getByLabel(/^Total/).fill("1000");
    await expect(card.getByLabel(/^Required deposit/)).toHaveValue("500.00");
    await expect(card.getByTestId("deposit-override")).toHaveCount(0);
    // Going below it asks the owner to say so; the button waits.
    await card.getByLabel(/^Required deposit/).fill("100");
    await expect(card.getByTestId("deposit-override")).toBeVisible();
    await expect(card.getByRole("button", { name: "Generate contract draft" })).toBeDisabled();
    await card.getByLabel(/^Required deposit/).fill("500");
    await card.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    const contractId = staff.url().split("/").pop()!;

    const { client } = await sendAndOpen(contractId, clientEmail);
    await expect(client.getByText(/Total: 1,000\.00 CAD\. Deposit: 500\.00 CAD\. Balance: 500\.00 CAD\./)).toBeVisible();
    await expect(client.locator("main")).toContainText("including its payment terms");
    await signAs(client, "Dana Client");
    await expect(client.getByTestId("signed-outcome")).not.toHaveAttribute("data-state", "booked");

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("event-header-status")).toHaveText("Signed · awaiting deposit");
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "record_payment");
    await staff.getByLabel(/Amount received/).fill("499.99");
    await staff.getByRole("button", { name: "Record payment" }).click();
    await expect(staff.getByTestId("event-header-status")).toHaveText("Signed · awaiting deposit");
    await staff.getByLabel(/Amount received/).fill("0.01");
    await staff.getByRole("button", { name: "Record payment" }).click();
    await expect(staff.getByTestId("event-header-status")).toHaveText("Booked");
    expect((await must(admin.from("events").select("lifecycle_status").eq("id", eventId).single())).data).toEqual({ lifecycle_status: "booked" });
  });

  test("a staff member can't go below the required deposit, and the form says so", async () => {
    const staffEmail = `e2e-wf-staff-${run}@example.test`;
    const { data: user } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await must(admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: user.user!.id, role: "staff" }));
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam Client", email: `e2e-wf-sam-${run}@example.test` }));
    const eventId = randomUUID();
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `Staff ${run}`, event_type: "wedding", event_date: "2027-09-18", contract_first: true }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    clientContexts.push(context);
    const page = await context.newPage();
    await signInStaff(page, staffEmail);
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const card = page.locator("#contract");
    await card.getByLabel("Template version").selectOption({ label: (await card.getByLabel("Template version").locator("option", { hasText: "Our agreement" }).first().textContent())! });
    await expect(card.getByTestId("deposit-owner-only")).toContainText("Only the owner");
    await expect(card.getByTestId("deposit-override")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Generate contract draft" })).toBeDisabled();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.goto(`/staff/${tenant.slug}/events/new`);
    await expect(page.getByTestId("booking-source")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("a business that confirms on signature gets no exception prompt, and its staff can generate", async () => {
    const db = await sessionFor(tenant.ownerEmail);
    const { data: t } = await must(admin.from("tenants").select("booking_policy_version").eq("id", tenant.id).single());
    await must(db.rpc("update_booking_policy", { p_tenant_id: tenant.id, p_policy: "on_signature", p_expected_version: t!.booking_policy_version }));
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Opal Client", email: `e2e-wf-opal-${run}@example.test` }));
    const eventId = randomUUID();
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `On signature ${run}`, event_type: "wedding", event_date: "2027-09-18", contract_first: true }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    clientContexts.push(context);
    const page = await context.newPage();
    await signInStaff(page, `e2e-wf-staff-${run}@example.test`);
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const card = page.locator("#contract");
    await card.getByLabel("Template version").selectOption({ label: (await card.getByLabel("Template version").locator("option", { hasText: "Our agreement" }).first().textContent())! });
    await expect(card.getByTestId("direct-no-terms")).toBeVisible();
    await expect(card.getByTestId("deposit-override")).toHaveCount(0);
    await expect(card.getByTestId("deposit-owner-only")).toHaveCount(0);
    await card.getByRole("button", { name: "Generate contract draft" }).click();
    await page.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("contract-no-terms")).toBeVisible();
    await must(db.rpc("update_booking_policy", { p_tenant_id: tenant.id, p_policy: "on_deposit", p_expected_version: t!.booking_policy_version + 1 }));
  });

  test("an event booked elsewhere is still created from the same form", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/new`);
    await staff.getByLabel("New client").check();
    await staff.getByLabel("Name", { exact: true }).fill("Eli Client");
    await staff.getByLabel("Email", { exact: true }).fill(`e2e-wf-ext-${run}@example.test`);
    await staff.getByTestId("booking-source").getByRole("radio", { name: /Already booked elsewhere/ }).check();
    await staff.getByLabel("Title", { exact: true }).fill(`Elsewhere ${run}`);
    await staff.getByLabel("Date", { exact: true }).fill("2027-08-28");
    await staff.getByRole("button", { name: "Create event" }).click();
    await staff.waitForURL(/\/events\/[0-9a-f-]{36}$/);
    await expect(staff.getByTestId("event-header-status")).toHaveText("Booked externally");
    const eventId = new URL(staff.url()).pathname.split("/").pop()!;
    expect((await must(admin.from("events").select("booking_source, contract_first").eq("id", eventId).single())).data).toEqual({ booking_source: "external", contract_first: false });
    await expect(staff.locator("#contract")).toHaveCount(0);
    await expect(staff.getByTestId("booking-steps-switch")).toHaveCount(0);
  });
});
