/**
 * Event email history and branded emails in real browsers, against Mailpit,
 * in dedicated test businesses: the owner saves a logo, sends a proposal from
 * the event page, and the client's email in Mailpit shows the business's
 * logo inline; the event's Emails section lists it as accepted by the
 * provider (never "Delivered" without the provider saying so); a failed email
 * is flagged and retried through the outbox (one email, not two); a provider
 * delivery event shows as Delivered; the Emails page agrees; another business
 * can't open the event; 320 px and keyboard.
 * The rules behind each step are in pgTAP 47 and the integration tests.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, MAILPIT, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { transparentPng } from "../support/logo-fixtures";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-comms-client-${run}@example.test`;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

type MailSummary = { ID: string; Subject: string };
async function mailpitMessages(to: string) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await res.json()) as { messages: MailSummary[] }).messages;
}

test.describe.serial("event email history and branded emails", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  let owner: Page;
  let eventId = "";
  let proposalId = "";
  let logoFile = "";

  test.beforeAll(async ({ browser: b }, info) => {
    browser = b;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    logoFile = join(dir, "wide.png");
    writeFileSync(logoFile, await transparentPng(1200, 300));
    tenant = await createTestTenant("comms", { catalog: true });
    other = await createTestTenant("comms-other");
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam Rivera", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Comms Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(owner, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("a proposal email carries the business's own logo inline and shows in the event's history as accepted, not delivered", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings#branding`);
    await owner.getByLabel("Logo", { exact: true }).setInputFiles(logoFile);
    await owner.getByLabel("Primary colour", { exact: true }).fill("#7c3aed");
    await owner.getByRole("button", { name: "Save branding" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();

    const sentAt = Date.now();
    const url = await sendProposalFromEventPage(owner, tenant, eventId);
    proposalId = url.split("/proposals/")[1];
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    expect(email.html).toContain('src="cid:business-logo"');
    expect(email.html).toContain(`alt="${tenant.displayName}"`);
    expect(email.html).toContain("background:#7c3aed");
    expect(email.text.split("\n")[0]).toBe(tenant.displayName);
    expect(email.text).toContain("Date: Saturday, September 18, 2027");
    const [summary] = await mailpitMessages(clientEmail);
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}`)).json()) as { Inline: { FileName: string; ContentID: string }[] };
    expect(message.Inline.map((i) => i.ContentID)).toEqual(["business-logo"]);

    await owner.goto(`/staff/${tenant.slug}/events/${eventId}#communications`);
    const history = owner.getByTestId("communications");
    const sent = history.locator('[data-type="proposal_sent"]');
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText(`To ${clientEmail}`);
    await expect(sent.getByTestId("communication-status")).toHaveText("Accepted by email provider");
    await expect(history).not.toContainText("Delivered");
    await sent.locator("summary").click();
    await expect(sent).toContainText("no confirmation that it reached the inbox");
    await expect(sent.getByRole("link", { name: "Open the proposal" })).toHaveAttribute("href", `/staff/${tenant.slug}/proposals/${proposalId}`);
    await expect(owner.getByTestId("communications-attention")).toHaveCount(0);
  });

  test("a failed email is flagged and retried once through the outbox", async () => {
    // An email whose submission failed for good (as after repeated provider errors).
    await admin.from("email_outbox").insert({
      tenant_id: tenant.id, event_type: "proposal_approved", recipient_email: clientEmail, entity_type: "proposal", entity_id: proposalId,
      payload: { event_title: `E2E Comms Wedding ${run}`, client_name: "Sam Rivera", total_cents: 250_000, currency: "CAD" },
      dedup_key: `e2e-comms-failed-${run}`, status: "failed", attempts: 5, max_attempts: 5, last_error: "Resend responded 503 secret-internal-detail",
    });
    await owner.reload();
    await expect(owner.getByTestId("communications-attention")).toHaveText("1 email needs your attention.");
    const failed = owner.locator('[data-testid="communication"][data-type="proposal_approved"]');
    await expect(failed.getByTestId("communication-status")).toHaveText("Couldn't be sent");
    await failed.locator("summary").click();
    await expect(failed).toContainText("The email provider refused it (HTTP 503). You can retry it.");
    await expect(failed).not.toContainText("secret-internal-detail");

    const retriedAt = Date.now();
    await failed.getByRole("button", { name: "Retry this email" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Queued for another attempt." })).toBeVisible();
    await waitForEmail(clientEmail, { after: retriedAt, subject: /approved your selection/ });
    await owner.reload();
    const retried = owner.locator('[data-testid="communication"][data-type="proposal_approved"]');
    await expect(retried.getByTestId("communication-status")).toHaveText("Accepted by email provider");
    await expect(retried.getByRole("button", { name: "Retry this email" })).toHaveCount(0); // nothing to resend by accident
    await expect(owner.getByTestId("communications-attention")).toHaveCount(0);
    expect((await mailpitMessages(clientEmail)).filter((m) => /approved your selection/.test(m.Subject))).toHaveLength(1);
  });

  test("a provider delivery event shows as Delivered, here and on the Emails page", async () => {
    const { data: row } = await admin.from("email_outbox").select("provider_message_id").eq("tenant_id", tenant.id).eq("event_type", "proposal_sent").single();
    await admin.rpc("record_email_provider_event", { p_provider_message_id: row!.provider_message_id!, p_status: "delivered", p_occurred_at: new Date().toISOString(), p_detail: null as unknown as string });
    await owner.reload();
    await expect(owner.locator('[data-testid="communication"][data-type="proposal_sent"]').getByTestId("communication-status")).toHaveText("Delivered");

    await owner.goto(`/staff/${tenant.slug}/emails`);
    const rows = owner.getByTestId("email-row");
    await expect(rows.filter({ hasText: "Proposal" })).toContainText("Delivered");
    await expect(rows.filter({ hasText: "Selection approved" })).toContainText("Accepted by email provider");
    await expect(owner.getByRole("main")).not.toContainText("secret-internal-detail");
  });

  test("the owner edits the reply-to, and a provider-confirmed bounce raises a dashboard warning", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings#reply-to`);
    const field = owner.getByLabel("Reply-to email");
    await field.fill("not-an-email@");
    await owner.getByRole("button", { name: "Save reply-to" }).click();
    await expect(field).toHaveJSProperty("validity.valid", false);
    await field.fill(`office-${run}@example.test`);
    await owner.getByRole("button", { name: "Save reply-to" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `now go to office-${run}@example.test` })).toBeVisible();
    expect((await admin.from("tenants").select("reply_to_email").eq("id", tenant.id).single()).data!.reply_to_email).toBe(`office-${run}@example.test`);

    // Accepted and delivered emails raise nothing; a hard bounce does, once.
    await owner.goto(`/staff/${tenant.slug}`);
    await expect(owner.getByTestId("email-failures")).toHaveCount(0);
    const { data: row } = await admin.from("email_outbox").select("provider_message_id").eq("tenant_id", tenant.id).eq("event_type", "proposal_approved").eq("status", "sent").single();
    for (let i = 0; i < 2; i++) {
      await admin.rpc("record_email_provider_event", { p_provider_message_id: row!.provider_message_id!, p_status: "bounced", p_occurred_at: new Date().toISOString(), p_detail: "Permanent · General" });
    }
    await owner.reload();
    await expect(owner.getByTestId("email-undelivered")).toHaveText("1 email was rejected by the recipient's mail server or not delivered.");
    await expect(owner.getByTestId("email-failures").getByRole("link", { name: "Review emails" })).toHaveAttribute("href", `/staff/${tenant.slug}/emails`);
  });

  test("another business can't open the event or its emails", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, other.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.goto(`/staff/${other.slug}/emails`);
    await expect(page.getByTestId("email-row")).toHaveCount(0);
    await page.context().close();
  });

  test("on a 320 px phone: no sideways scrolling, and entries open from the keyboard", async () => {
    const page = await (await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/events/${eventId}#communications`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const entry = page.getByTestId("communication").first();
    await entry.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(entry.locator("details")).toHaveAttribute("open", "");
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto(`/staff/${tenant.slug}/emails`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });
});
