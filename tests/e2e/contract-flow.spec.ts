/**
 * Phase 2 step 1 in a real browser against local Supabase: staff publish a
 * contract template, approve a real submission, generate a contract draft,
 * read it on a phone, replace it, and confirm nobody else can open it.
 * The client's submission is made through the same service functions the
 * client page uses (that page is covered by proposal-flow.spec.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DEMO_TEMPLATE_TEXT, DEMO_TEMPLATE_TITLE } from "../../src/lib/contracts/demo-template";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

// Dedicated test tenants; never the seeded BOUPROD or Other DJ.
let tenant: TestTenant;
let otherTenant: TestTenant;
const run = randomUUID().slice(0, 6);
const templateName = `E2E contract ${run}`;
const clientName = `Robin <b>&</b> Kai {{pricing.total}}`;
const eventTitle = `E2E Contract Wedding ${run}`;

const cad = (cents: number) => `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(cents / 100)} CAD`;

test.describe.serial("contract templates and contract drafts", () => {
  let browser: Browser;
  let context: BrowserContext;
  let staff: Page;
  let eventId = "";
  let proposalUrl = "";
  let contractUrl = "";
  let totalCents = 0;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("contract", { catalog: true });
    otherTenant = await createTestTenant("contract-other");
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: clientName, email: `contract-${run}@example.test`, phone: "+1 514 555 0142" });
    // No venue address yet: generation must say so instead of rendering a blank.
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-09-18", venue_name: "E2E Loft" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    context = await browser.newContext();
    staff = await context.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(otherTenant);
  });

  test("staff create, validate and publish a template; published versions are read-only", async () => {
    await staff.goto(`/staff/${tenant.slug}`);
    await staff.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Contract templates" }).click();
    await expect(staff.getByRole("heading", { name: "Contract templates" })).toBeVisible();
    await staff.getByLabel("Template name").fill(templateName);
    await expect(staff.getByLabel("Sections")).toHaveValue(DEMO_TEMPLATE_TEXT);
    await staff.getByRole("button", { name: "Create template draft" }).click();
    await staff.waitForURL(/\/contract-templates\/[0-9a-f-]{36}$/);
    await expect(staff.getByText("Draft version 1")).toBeVisible();
    await expect(staff.getByText("{{payment.balance_due_date}}", { exact: true })).toBeVisible();

    const sections = staff.getByLabel("Sections");
    await sections.fill(`${DEMO_TEMPLATE_TEXT}\n\n## Extra\nDear {{client.nickname}}`);
    await staff.getByRole("button", { name: "Save draft" }).click();
    await expect(staff.getByRole("alert").filter({ hasText: "can't be used" })).toHaveText("This template can't be used: unknown placeholder {{client.nickname}}.");

    // Back to the saved text: nothing is unsaved. A real edit blocks publishing until saved.
    await sections.fill(DEMO_TEMPLATE_TEXT);
    await expect(staff.getByRole("button", { name: "Publish…" })).toBeEnabled();
    await staff.getByLabel("Document title").fill(`${DEMO_TEMPLATE_TITLE} (v1)`);
    await expect(staff.getByText("Save your changes before publishing.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Publish…" })).toBeDisabled();
    await staff.getByRole("button", { name: "Save draft" }).click();
    await expect(staff.getByText("Draft saved. It is not published yet.")).toBeVisible();

    // The starter text is DEMO wording, so it is published as DEMO.
    await staff.getByRole("button", { name: "Publish…" }).click();
    const dialog = staff.getByRole("dialog", { name: "Confirm publishing" });
    await dialog.getByRole("radio", { name: /DEMO, for testing/ }).check();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Publish version 1 as DEMO" }).click();
    await expect(staff.getByRole("button", { name: "Start draft version 2" })).toBeVisible();
    await expect(staff.getByText(/Version 1 · published/)).toBeVisible();
    await expect(staff.getByLabel("Sections")).toHaveCount(0);
  });

  test("staff approve a real submission; missing details block generation with clear guidance", async () => {
    proposalUrl = await sendProposalFromEventPage(staff, tenant, eventId);
    ({ totalCents } = await submitAsClient(tenant, proposalUrl.split("/").pop()!));

    await staff.reload();
    await expect(staff.getByText("Generate contract draft")).toHaveCount(0);
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await expect(staff.getByText(/Next: generate the contract draft\. The event is not booked\./)).toBeVisible();

    await staff.getByLabel("Template version").selectOption({ label: `${templateName} · version 1 · DEMO (latest published)` });
    await staff.getByRole("button", { name: "Generate contract draft" }).click();
    const missing = staff.getByRole("alert").filter({ hasText: "Nothing was generated" });
    await expect(missing).toContainText("Venue address: add it to the event.");
    await expect(missing).toContainText("Balance due date: enter it when generating the contract.");
    await expect(missing).not.toContainText("Venue name");
    const { count } = await admin.from("contracts").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(count).toBe(0);
  });

  test("a generated draft shows the exact agreement, safely and readably on a phone", async () => {
    await admin.from("events").update({ venue_address: "77 Rue E2E, Montréal" }).eq("id", eventId);
    await staff.getByLabel("Balance due date").fill("2027-08-18");
    await staff.getByRole("button", { name: "Generate contract draft" }).dblclick();
    await staff.waitForURL(new RegExp(`/staff/${tenant.slug}/contracts/[0-9a-f-]{36}$`));
    contractUrl = staff.url();
    const { data: rows } = await admin.from("contracts").select("id, status, total_cents").eq("event_id", eventId);
    expect(rows).toEqual([{ id: contractUrl.split("/").pop(), status: "draft", total_cents: totalCents }]);

    const article = staff.locator("article");
    await expect(article.getByRole("heading", { level: 1 })).toHaveText(`DEMO, NOT FOR CLIENT USE: DJ services agreement for ${eventTitle} (v1)`);
    expect(DEMO_TEMPLATE_TITLE).toContain("{{event.title}}");
    await expect(staff.getByText(/Draft preview for staff\. It has not been sent/)).toBeVisible();
    const deposit = Number((BigInt(totalCents) * BigInt(5000) + BigInt(5000)) / BigInt(10000));
    await expect(article).toContainText(`Deposit due on signing (50% of the total including taxes): ${cad(deposit)}`);
    await expect(article).toContainText(`Remaining balance: ${cad(totalCents - deposit)}, due August 18, 2027.`);
    await expect(article).toContainText("Venue: E2E Loft, 77 Rue E2E, Montréal");
    // The client's name is shown literally: no markup, no second placeholder pass.
    await expect(article).toContainText(`Client: ${clientName}, contract-${run}@example.test`);
    await expect(article.locator("b")).toHaveCount(0);

    const { data: event } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(event).toEqual({ lifecycle_status: "awaiting_signature", booking_confirmed_at: null });
    const { count: access } = await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(access).toBe(0);

    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(contractUrl);
    await expect(phone.locator("article").getByRole("heading", { level: 1 })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const fontSize = await phone.locator("article p").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
    await phone.close();
  });

  test("regenerating needs confirmation and keeps the replaced draft as history", async () => {
    await staff.goto(proposalUrl);
    await staff.getByLabel("Template version").selectOption({ label: `${templateName} · version 1 · DEMO (latest published)` });
    await staff.getByLabel("Balance due date").fill("2027-08-25");
    await staff.getByRole("button", { name: "Regenerate draft…" }).click();
    const dialog = staff.getByRole("dialog", { name: "Confirm replacing the draft" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await staff.getByRole("button", { name: "Regenerate draft…" }).click();
    await dialog.getByRole("button", { name: "Replace draft" }).click();
    await staff.waitForURL((url) => url.pathname.includes("/contracts/") && !contractUrl.endsWith(url.pathname));
    await expect(staff.locator("article")).toContainText("due August 25, 2027.");

    await staff.goto(contractUrl);
    await expect(staff.getByText("This draft was replaced by a newer draft and can't be used.")).toBeVisible();
    await expect(staff.getByText("Replaced by a newer draft", { exact: true })).toBeVisible();
    const { data: rows } = await admin.from("contracts").select("status").eq("event_id", eventId).order("status");
    expect(rows).toEqual([{ status: "draft" }, { status: "replaced" }]);
  });

  test("signed-out visitors and another DJ cannot open the contract", async () => {
    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto(contractUrl);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("body")).not.toContainText("DEMO, NOT FOR CLIENT USE");

    await signInStaff(page, otherTenant.ownerEmail);
    const contractId = contractUrl.split("/").pop();
    for (const url of [contractUrl, `/staff/${otherTenant.slug}/contracts/${contractId}`]) {
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
      await expect(page.locator("body")).not.toContainText(eventTitle);
    }
    await anon.close();
  });
});
