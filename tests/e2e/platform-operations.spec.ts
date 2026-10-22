/**
 * Platform → Operations in a real browser against local Supabase: a platform
 * administrator sees the worker's health, the summary and this suite's own
 * failed, possibly delivered and overdue emails, with no recipient or link;
 * a business owner gets the same 404 as any non-administrator, and a signed-out
 * visitor is sent to sign in. Other local data may also be listed, so only
 * this suite's rows are checked. Authorization itself is proven in pgTAP
 * (62_platform_operations).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

test.describe.configure({ mode: "serial" });

let browser: Browser;
let operator: TestTenant;
let business: TestTenant;
let page: Page;
const rows: Record<string, string> = {};
const recipient = `e2e-ops-client-${randomUUID().slice(0, 8)}@example.test`;

async function email(status: string, attempts: number, nextAttemptMinutes: number, lastError: string | null) {
  const { data, error } = await admin
    .from("email_outbox")
    .insert({
      tenant_id: business.id,
      event_type: "proposal_sent",
      recipient_email: recipient,
      entity_type: "proposal",
      entity_id: randomUUID(),
      dedup_key: `e2e-ops:${randomUUID()}`,
      status,
      attempts,
      next_attempt_at: new Date(Date.now() + nextAttemptMinutes * 60_000).toISOString(),
      last_error: lastError,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  operator = await createTestTenant("ops-admin");
  business = await createTestTenant("ops-business");
  grantPlatformAdminLocally(operator.ownerEmail);
  rows.failed = await email("failed", 5, -60, "Resend responded 500");
  rows.possibly = await email("failed", 5, -60, "delivery did not complete");
  rows.overdue = await email("pending", 0, -30, null);
  rows.retrying = await email("pending", 2, 10, "Resend responded 503");
});

test.afterAll(async () => {
  try {
    if (operator) revokePlatformAdminLocally(operator.ownerEmail);
  } finally {
    await archiveTestTenant(business);
    await archiveTestTenant(operator);
  }
});

test("a platform administrator sees the worker, the summary and this business's email issues, without recipients", async () => {
  page = await (await browser.newContext()).newPage();
  await signInWithLink(page, operator.ownerEmail, "/platform/operations");
  await page.goto("/platform/operations");
  await expect(page.getByRole("heading", { name: "Platform Operations" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Operations" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("worker-health")).toBeVisible();
  for (const stat of ["stat-emails-failed", "stat-emails-overdue", "stat-emails-retrying", "stat-documents-failed", "stat-documents-overdue"]) {
    await expect(page.getByTestId(stat)).toBeVisible();
  }
  expect(Number(await page.getByTestId("stat-emails-failed").getAttribute("data-value"))).toBeGreaterThanOrEqual(2);

  const row = (id: string) => page.locator(`[data-testid="ops-email"][data-id="${id}"]`);
  await expect(row(rows.failed)).toHaveAttribute("data-issue", "failed");
  await expect(row(rows.failed)).toContainText("Failed");
  await expect(row(rows.failed)).toContainText(business.displayName);
  await expect(row(rows.possibly)).toContainText("Possibly delivered");
  await expect(row(rows.overdue)).toHaveAttribute("data-issue", "overdue");
  await expect(row(rows.overdue)).toContainText("Overdue");
  // A normal retry isn't an issue.
  await expect(row(rows.retrying)).toHaveCount(0);
  // Never the recipient (or any link).
  await expect(page.locator("main")).not.toContainText(recipient);
  // Card titles are styled text, not headings, in this design system.
  await expect(page.getByText("Signed PDFs needing attention", { exact: true })).toBeVisible();
});

test("the page fits a phone screen", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Platform Operations" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.context().close();
});

test("a business owner gets the same 404 as any non-administrator", async () => {
  const owner = await (await browser.newContext()).newPage();
  await signInWithLink(owner, business.ownerEmail);
  const response = await owner.goto("/platform/operations");
  expect(response?.status()).toBe(404);
  await expect(owner.getByRole("heading", { name: "Platform Operations" })).toHaveCount(0);
  await owner.context().close();
});

test("a signed-out visitor is sent to sign in", async () => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto("/platform/operations");
  await expect(visitor).toHaveURL(/\/login/);
  await visitor.context().close();
});
