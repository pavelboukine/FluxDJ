/**
 * Business settings -> contract generation -> review for send, in a real
 * browser against local Supabase, inside a dedicated test tenant.
 * Sending is covered by contract-send-flow.spec.ts; here a stale review blocks it.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const staffEmail = `e2e-staff-member-${run}@example.test`;
const cad = (cents: number) => `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(cents / 100)}`;
const depositAt = (total: number, percent: number) => Number((BigInt(total) * BigInt(percent) + BigInt(50)) / BigInt(100));

const sections = (withDeadline: boolean) => [
  { heading: "Parties", body: "{{business.legal_name}}, {{business.address}}, {{business.email}}\nClient: {{client.name}}" },
  {
    heading: "Payment",
    body: `Deposit ({{payment.deposit_percent}}): {{payment.deposit}}\nBalance: {{payment.balance}}${withDeadline ? ", due {{payment.balance_due_date}}" : ""}`,
  },
];

/** Publishes a template version directly (the template UI is covered by contract-flow.spec.ts). */
async function publishTemplate(name: string, withDeadline: boolean): Promise<string> {
  const templateId = randomUUID();
  const versionId = randomUUID();
  await admin.from("contract_templates").insert({ id: templateId, tenant_id: tenant.id, name });
  await admin.from("contract_template_versions").insert({
    id: versionId, tenant_id: tenant.id, template_id: templateId, version_number: 1, title: `${name} for {{event.title}}`, sections: sections(withDeadline),
  });
  const { error } = await admin.from("contract_template_versions").update({ published_at: new Date().toISOString(), usage: "demo" }).eq("id", versionId);
  if (error) throw error;
  return versionId;
}

test.describe.serial("business settings, contract generation and review", () => {
  let browser: Browser;
  let ownerContext: BrowserContext;
  let owner: Page;
  let eventId = "";
  let proposalUrl = "";
  let olderVersion = "";
  let newerVersion = "";
  let totalCents = 0;
  let contractId = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("settings", { catalog: true });
    // Start without a legal identity, as a new business would.
    await admin.from("tenants").update({ business_address: null, contact_email: null }).eq("id", tenant.id);
    const { data: member } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: member.user!.id, role: "staff" });

    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Dana & Lou", email: `dana-${run}@example.test` });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Settings Wedding ${run}`, event_type: "wedding", event_date: "2027-08-21" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });

    olderVersion = await publishTemplate("Agreement A (older)", false);
    await new Promise((r) => setTimeout(r, 1100)); // distinct publish times
    newerVersion = await publishTemplate("Agreement B (newer)", true);

    ownerContext = await browser.newContext();
    owner = await ownerContext.newPage();
    await signInStaff(owner, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("only the owner can change business settings, and values are validated", async () => {
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await signInStaff(staff, staffEmail);
    await expect(staff.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" })).toBeVisible();
    await staff.goto(`/staff/${tenant.slug}/settings`);
    await expect(staff.getByText("Only the owner can change business settings.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Save settings" })).toHaveCount(0);
    await staffContext.close();

    await owner.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" }).click();
    await expect(owner.getByRole("heading", { name: "Business settings" })).toBeVisible();
    await expect(owner.getByLabel("Deposit due on signing (%)")).toHaveValue("50");
    await owner.getByLabel("Legal business name").fill("E2E Legal Sound Inc.");
    await owner.getByLabel("Business address").fill("5 Rue E2E, Montréal, QC");
    await owner.getByLabel("Contact email").fill("Legal@E2E.example.test");
    // Browsers allow typing a decimal into a number field; the server refuses it.
    await owner.getByLabel("Deposit due on signing (%)").evaluate((el: HTMLInputElement) => el.setAttribute("step", "any"));
    await owner.getByLabel("Deposit due on signing (%)").fill("30.5");
    await owner.getByRole("button", { name: "Save settings" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "whole percentage" })).toBeVisible();
    await owner.getByLabel("Deposit due on signing (%)").fill("30");
    await owner.getByRole("button", { name: "Save settings" }).click();
    await expect(owner.getByText(/Settings saved/)).toBeVisible();
    const { data } = await admin.from("tenants").select("business_name, business_address, contact_email, deposit_percent, display_name").eq("id", tenant.id).single();
    expect(data).toEqual({
      business_name: "E2E Legal Sound Inc.", business_address: "5 Rue E2E, Montréal, QC", contact_email: "legal@e2e.example.test",
      deposit_percent: 30, display_name: tenant.displayName,
    });
  });

  test("generation defaults to the latest published version and allows choosing another", async () => {
    proposalUrl = await sendProposalFromEventPage(owner, tenant, eventId);
    ({ totalCents } = await submitAsClient(tenant, proposalUrl.split("/").pop()!));
    await owner.reload();
    await owner.getByRole("button", { name: "Approve…" }).click();
    await owner.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();

    const select = owner.getByLabel("Template version");
    await expect(select.locator("option:checked")).toHaveText("Agreement B (newer) · version 1 · DEMO (latest published)");
    await select.selectOption({ label: "Agreement A (older) · version 1 · DEMO" });
    await expect(owner.getByLabel("Balance due date")).toBeDisabled();
    await owner.getByRole("button", { name: "Generate contract draft" }).click();
    await owner.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    const { data: first } = await admin.from("contracts").select("id, template_version_id, deposit_percent").eq("event_id", eventId).single();
    expect(first).toMatchObject({ template_version_id: olderVersion, deposit_percent: 30 });
    await expect(owner.getByText("Deposit on signing (30%)")).toBeVisible();

    // Regenerate with the default (latest) version and an explicit deadline.
    await owner.goto(proposalUrl);
    await expect(owner.getByLabel("Template version").locator("option:checked")).toHaveText(/latest published/);
    await owner.getByLabel("Balance due date").fill("2027-08-01");
    await owner.getByRole("button", { name: "Regenerate draft…" }).click();
    await owner.getByRole("dialog", { name: "Confirm replacing the draft" }).getByRole("button", { name: "Replace draft" }).click();
    await owner.waitForURL((url) => url.pathname.includes("/contracts/") && !url.pathname.endsWith(first!.id));
    contractId = owner.url().split("/").pop()!;
    const { data: second } = await admin.from("contracts").select("template_version_id, deposit_cents, balance_cents, balance_due_date").eq("id", contractId).single();
    expect(second).toEqual({
      template_version_id: newerVersion, deposit_cents: depositAt(totalCents, 30), balance_cents: totalCents - depositAt(totalCents, 30), balance_due_date: "2027-08-01",
    });
  });

  test("review shows exactly what would be sent; a stale review blocks sending", async () => {
    await owner.getByRole("link", { name: "Review and send…" }).click();
    await owner.waitForURL(/\/review$/);
    await expect(owner.getByText("Ready to send")).toBeVisible();
    await expect(owner.getByText("Dana & Lou", { exact: true })).toBeVisible();
    await expect(owner.getByText(`dana-${run}@example.test`, { exact: true })).toBeVisible();
    await expect(owner.getByText("E2E Legal Sound Inc.", { exact: true })).toBeVisible();
    await expect(owner.getByText("legal@e2e.example.test", { exact: true })).toBeVisible();
    await expect(owner.getByText("Deposit on signing (30%)")).toBeVisible();
    await expect(owner.getByText(cad(depositAt(totalCents, 30)), { exact: true })).toBeVisible();
    await expect(owner.getByText("2027-08-01")).toBeVisible();
    const article = owner.locator("article");
    await expect(article).toContainText("E2E Legal Sound Inc., 5 Rue E2E, Montréal, QC, legal@e2e.example.test");
    await expect(article).toContainText("Deposit (30%):");
    await expect(article).toContainText("due August 1, 2027");

    await expect(owner.getByRole("button", { name: "Send contract…" })).toBeEnabled();

    // A settings change after generation makes the review stale until regenerated.
    await owner.goto(`/staff/${tenant.slug}/settings`);
    await owner.getByLabel("Deposit due on signing (%)").fill("40");
    await owner.getByRole("button", { name: "Save settings" }).click();
    await expect(owner.getByText(/Settings saved/)).toBeVisible();
    await owner.goto(`/staff/${tenant.slug}/contracts/${contractId}/review`);
    await expect(owner.getByText("Not ready")).toBeVisible();
    await expect(owner.getByRole("alert").filter({ hasText: "can't be sent" })).toContainText(
      "The deposit setting is now 40%, but this contract uses 30%. Regenerate the contract to use the current setting.",
    );
    await expect(owner.getByRole("button", { name: "Send contract…" })).toBeDisabled();
    await expect(owner.getByText("Fix the problems above before sending.")).toBeVisible();

    const { data: contract } = await admin.from("contracts").select("status, deposit_percent").eq("id", contractId).single();
    expect(contract).toEqual({ status: "draft", deposit_percent: 30 });
    const { count: emails } = await admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("entity_id", contractId);
    expect(emails).toBe(0);
    const { count: links } = await admin.from("access_links").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).neq("purpose", "proposal");
    expect(links).toBe(0);
  });
});
