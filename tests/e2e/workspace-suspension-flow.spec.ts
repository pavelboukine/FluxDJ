/**
 * Workspace suspension in real browsers: a platform administrator (who owns
 * another throwaway business) suspends and restores a test workspace on a
 * phone-sized screen, while its owner and a client keep pages open.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff, signInWithLink, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-susp-client-${run}@example.test`;
const REASON = `Internal note ${run}: chargeback under review`;

test.describe.serial("workspace suspension", () => {
  let browser: Browser;
  let dj: TestTenant;
  let operatorsOwn: TestTenant;
  let operator: Page;
  let owner: Page;
  let client: Page;
  let proposalLink = "";
  let proposalUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    dj = await createTestTenant("susp", { catalog: true });
    operatorsOwn = await createTestTenant("susp-op");
    grantPlatformAdminLocally(operatorsOwn.ownerEmail);

    const eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: dj.id, name: "Robin & Kai", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: dj.id, title: `E2E Suspension Wedding ${run}`, event_type: "wedding", event_date: "2027-10-02" });
    await admin.from("event_clients").insert({ tenant_id: dj.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });

    owner = await (await browser.newContext()).newPage();
    await signInStaff(owner, dj.ownerEmail);
    const sentAt = Date.now();
    await sendProposalFromEventPage(owner, dj, eventId);
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    proposalLink = /(http:\/\/\S+\/p#\S+)/.exec(email.text)![1];
    client = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await client.goto(proposalLink);
    await client.waitForURL("**/proposals/**");
    proposalUrl = client.url();

    operator = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await signInWithLink(operator, operatorsOwn.ownerEmail, "/platform/workspaces");
    await operator.waitForURL("**/platform/workspaces");
  });

  test.afterAll(async () => {
    try {
      const { data } = await admin.from("tenants").select("suspended_at").eq("id", dj.id).single();
      if (data?.suspended_at && operator) {
        await operator.goto("/platform/workspaces");
        const row = operator.getByTestId("workspace").filter({ hasText: `/${dj.slug}` });
        await row.getByRole("button", { name: "Restore…" }).click({ timeout: 5000 });
        await row.getByLabel("Internal reason").fill("Test cleanup", { timeout: 5000 });
        await row.getByRole("button", { name: "Restore workspace" }).click({ timeout: 5000 });
      }
    } finally {
      // Archived either way, so a leftover never appears anywhere.
      revokePlatformAdminLocally(operatorsOwn.ownerEmail);
      await archiveTestTenant(dj);
      await archiveTestTenant(operatorsOwn);
    }
  });

  test("only platform administrators can open the workspace list", async () => {
    await owner.goto("/platform/workspaces");
    await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("the administrator's own workspace can't be suspended from their account", async () => {
    const own = operator.getByTestId("workspace").filter({ hasText: `/${operatorsOwn.slug}` });
    await expect(own).toContainText("Yours");
    await expect(own).toContainText("can't be suspended from your account");
    await expect(own.getByRole("button", { name: "Suspend…" })).toHaveCount(0);
    expect(await operator.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("suspending explains the effects, needs a reason and blocks the owner and client on their next request", async () => {
    // The owner has Settings open with a typed change when the suspension happens.
    await owner.goto(`/staff/${dj.slug}/settings`);
    await owner.getByLabel("Contact email").fill(`changed-${run}@example.test`);

    const row = operator.getByTestId("workspace").filter({ hasText: `/${dj.slug}` });
    await row.getByRole("button", { name: "Suspend…" }).click();
    const dialog = operator.getByRole("dialog", { name: `Suspend ${dj.displayName} (/${dj.slug})?` });
    await expect(dialog).toContainText("Its owner and staff lose access to this workspace");
    await expect(dialog).toContainText("Emails waiting to be sent are cancelled");
    await expect(dialog).toContainText("can't be recalled");
    await dialog.getByRole("button", { name: "Suspend workspace" }).click();
    await expect(dialog.getByLabel("Internal reason")).toHaveJSProperty("validity.valueMissing", true);
    await dialog.getByLabel("Internal reason").fill(REASON);
    await dialog.getByRole("button", { name: "Suspend workspace" }).click();
    await expect(row.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(row).toContainText(REASON);
    // The Restore panel starts closed and empty (nothing carried over from the suspension form).
    await expect(row.getByRole("button", { name: "Restore…" })).toBeVisible();
    expect(await operator.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // The open Settings tab: saving reaches the server, which refuses, and nothing claims it was saved.
    await owner.getByRole("button", { name: "Save settings" }).click();
    await owner.waitForURL("**/unavailable");
    await expect(owner.getByText("This workspace is unavailable", { exact: true })).toBeVisible();
    await expect(owner.locator("body")).not.toContainText("chargeback");
    const { data: tenant } = await admin.from("tenants").select("contact_email").eq("id", dj.id).single();
    expect(tenant!.contact_email).not.toBe(`changed-${run}@example.test`);
    await owner.goto(`/staff/${dj.slug}/events`);
    await owner.waitForURL("**/unavailable");

    // The client: the open proposal and the emailed link are temporarily unavailable.
    await client.reload();
    await expect(client.getByText("This proposal is temporarily unavailable", { exact: true })).toBeVisible();
    await client.goto(proposalLink);
    await expect(client.getByText("This proposal is temporarily unavailable. Please try again later or contact your DJ.")).toBeVisible();
    await expect(client.locator("body")).not.toContainText("chargeback");
  });

  test("restoring needs confirmation and a reason, sends nothing and brings access back", async () => {
    const before = (await admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("tenant_id", dj.id)).count;
    const row = operator.getByTestId("workspace").filter({ hasText: `/${dj.slug}` });
    await row.getByRole("button", { name: "Restore…" }).click();
    const dialog = operator.getByRole("dialog", { name: `Restore ${dj.displayName} (/${dj.slug})?` });
    await expect(dialog).toContainText("Nothing is sent");
    await dialog.getByLabel("Internal reason").fill("Chargeback resolved");
    await dialog.getByRole("button", { name: "Restore workspace" }).click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    expect((await admin.from("email_outbox").select("id", { count: "exact", head: true }).eq("tenant_id", dj.id)).count).toBe(before);

    await owner.goto(`/staff/${dj.slug}`);
    await expect(owner.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await client.goto(proposalUrl);
    await expect(client.getByText(`E2E Suspension Wedding ${run}`).first()).toBeVisible();
  });
});
