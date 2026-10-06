/**
 * Voiding a sent contract, in real browsers against local Supabase and
 * Mailpit, inside a dedicated test tenant:
 *  - staff and client in separate browser contexts;
 *  - the client's sign-in replacing the staff session in the same browser,
 *    then a stale staff tab trying to void (it must not, and must explain);
 *  - the void notification email (no internal reason, no link).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff, verifyContractInvitation, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-void-signer-${run}@example.test`;
const eventTitle = `E2E Void Wedding ${run}`;
const BASE = "http://127.0.0.1:3000";

/** Staff generate and send the current contract from the approved proposal; returns its staff URL. */
async function sendContractFromProposal(staff: Page, proposalUrl: string): Promise<{ url: string; sentAt: number }> {
  await staff.goto(proposalUrl);
  await staff.getByRole("button", { name: "Generate contract draft" }).click();
  await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
  const url = staff.url();
  await staff.getByRole("link", { name: "Review and send…" }).click();
  await staff.getByRole("button", { name: "Send contract…" }).click();
  const sentAt = Date.now();
  await staff.getByRole("dialog", { name: "Confirm sending the contract" }).getByRole("button", { name: "Send contract now" }).click();
  await staff.waitForURL(url);
  return { url, sentAt };
}

/** The client follows the contract email, verifies their address and opens the contract in `page`. */
async function clientOpensContract(page: Page, sentAt: number): Promise<string> {
  const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
  await verifyContractInvitation(page, new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1], clientEmail);
  // A first visit accepts with a button; a client who already has access gets a link.
  await page.getByRole("button", { name: "Open my contract" }).or(page.getByRole("link", { name: "Open my contract" })).click();
  await page.waitForURL(new RegExp(`/${tenant.slug}/contracts/[0-9a-f-]{36}$`));
  return page.url();
}

async function voidFromStaffPage(staff: Page, reason: string) {
  await staff.getByRole("button", { name: "Void…" }).click();
  await staff.getByLabel("Reason (kept in the record)").fill(reason);
  await staff.getByRole("button", { name: "Void contract" }).click();
}

test.describe.serial("voiding sent contracts", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let eventId = "";
  let proposalUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("void", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Avery & Jun", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-10-02" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Parties", body: "{{business.legal_name}} and {{client.name}}" },
    ]);
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    proposalUrl = await sendProposalFromEventPage(staff, tenant, eventId);
    await submitAsClient(tenant, proposalUrl.split("/").pop()!);
    await staff.reload();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("separate browsers: staff void, keep history and dashboard; the signed-in client loses access and is notified without the reason", async () => {
    const { url, sentAt } = await sendContractFromProposal(staff, proposalUrl);
    const clientContext = await browser.newContext();
    const client = await clientContext.newPage();
    const clientUrl = await clientOpensContract(client, sentAt);
    await expect(client.getByRole("heading", { level: 1 })).toContainText(eventTitle);

    const voidedAt = Date.now();
    await voidFromStaffPage(staff, `Internal reason ${run}: wrong venue`);
    await expect(staff.getByText(new RegExp(`Voided .*: Internal reason ${run}`))).toBeVisible();
    await expect(staff.getByText("Void", { exact: true })).toBeVisible();

    // Staff keep their workspace and the historical void contract.
    await staff.goto(`/staff/${tenant.slug}`);
    await expect(staff.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByRole("link", { name: /Agreement \(DEMO\) v1/ }).first().click();
    await expect(staff.getByText(new RegExp(`Voided .*: Internal reason ${run}`))).toBeVisible();
    expect(staff.url()).toBe(url);

    // The already signed-in client can no longer read it.
    await client.reload();
    await expect(client.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
    await client.goto(clientUrl);
    await expect(client.locator("body")).not.toContainText(eventTitle);

    // One notification, without the internal reason or any link.
    const notice = await waitForEmail(clientEmail, { after: voidedAt, subject: /no longer available/ });
    expect(notice.text).toContain(eventTitle);
    expect(notice.text).not.toContain("Internal reason");
    expect(notice.text).not.toMatch(/https?:\/\//);
    expect(notice.text).not.toMatch(/cancel/i);
    await clientContext.close();
  });

  test("same browser: a client sign-in replaces the staff session; the stale staff tab cannot void and is told to sign in again", async () => {
    const { url, sentAt } = await sendContractFromProposal(staff, proposalUrl);
    const contractId = url.split("/").pop()!;
    // The staff tab stays open on the contract while, in the same browser, the client signs in.
    await staff.goto(url);
    const clientTab = await staffContext.newPage();
    await clientOpensContract(clientTab, sentAt);
    await clientTab.close();

    await voidFromStaffPage(staff, "Should not happen");
    await staff.waitForURL(/\/login\?notice=no-staff-access$/);
    const notice = staff.getByRole("alert").filter({ hasText: "no staff access" });
    await expect(notice).toContainText(`You're signed in as ${clientEmail}, which has no staff access, so nothing was changed.`);
    await expect(notice).toContainText("client sign-in link in this browser");
    const { data: still } = await admin.from("contracts").select("status").eq("id", contractId).single();
    expect(still).toEqual({ status: "sent" });

    // Staff pages explain the same instead of a bare 404.
    await staff.goto(`/staff/${tenant.slug}`);
    await staff.waitForURL(/\/login\?notice=no-staff-access$/);

    // Signing in again as staff restores the workspace, and the void then works.
    await signInStaff(staff, tenant.ownerEmail);
    await staff.goto(url);
    await voidFromStaffPage(staff, "Replaced after review");
    await expect(staff.getByText(/Voided .*: Replaced after review/)).toBeVisible();
    const { data: voided } = await admin.from("contracts").select("status").eq("id", contractId).single();
    expect(voided).toEqual({ status: "void" });
  });
});
