/**
 * Manual payments in a real browser against local Supabase, in a dedicated
 * test tenant: staff record payments on the event page (double clicks,
 * duplicate confirmation, invalidation with a reason, an invoice link),
 * terms appear once a contract is sent, and the verified client sees a
 * narrow read-only summary. Staff and client use separate browsers.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff, verifyContractInvitation, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-pay-${run}@example.test`;
const BASE = "http://127.0.0.1:3000";

test.describe.serial("manual payments", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let eventId = "";
  let eventUrl = "";
  let contractId = "";
  let sentAt = 0;
  let clientContext: BrowserContext;
  let client: Page;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("pay", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Riley Park", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Pay Wedding ${run}`, event_type: "wedding", event_date: "2027-11-06" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
    ]);
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    eventUrl = `/staff/${tenant.slug}/events/${eventId}`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("staff record payments before any contract; nothing is invented", async () => {
    await staff.goto(eventUrl);
    const card = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Payments", { exact: true }) });
    await expect(card).toContainText("No contract has been sent yet, so there is no total or deposit to compare.");
    await expect(card).not.toContainText("Remaining balance");

    await card.getByLabel(/Amount received/).fill("250");
    await card.getByLabel("Reference (optional)").fill("ET-STAFF-ONLY-123");
    await card.getByLabel("Internal note (optional)").fill("Staff-only note about the deposit");
    await card.getByRole("button", { name: "Record payment" }).dblclick();
    await expect(card.getByText("Payment recorded.")).toBeVisible();
    await expect(card.getByLabel(/Amount received/)).toHaveValue("");
    const { data: rows } = await admin.from("event_payments").select("amount_cents").eq("event_id", eventId);
    expect(rows).toEqual([{ amount_cents: 25000 }]);
    await expect(card.getByLabel("Payment summary")).toContainText("Received so far$250.00");

    // The same amount and date again needs confirmation.
    await card.getByLabel(/Amount received/).fill("250.00");
    await card.getByRole("button", { name: "Record payment" }).click();
    await expect(card.getByRole("alert")).toContainText("A payment with the same amount and date is already recorded for this event.");
    await expect(card.getByLabel(/Amount received/)).toHaveValue("250.00");
    await card.getByLabel(/This is a separate payment/).check();
    await card.getByRole("button", { name: "Record payment" }).click();
    await expect(card.getByText("Payment recorded.")).toBeVisible();
    await expect(card.getByLabel("Payment summary")).toContainText("Received so far$500.00");

    // Invalidate the second one, with a reason; it stays in the history.
    const history = card.getByLabel("Payment history");
    await history.getByRole("button", { name: "Invalidate…" }).first().click();
    const dialog = staff.getByRole("dialog", { name: "Confirm invalidating the payment" });
    await expect(dialog.getByRole("button", { name: "Invalidate payment" })).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("Recorded twice by mistake");
    await dialog.getByRole("button", { name: "Invalidate payment" }).click();
    await expect(history).toContainText("Recorded twice by mistake");
    await expect(card.getByLabel("Payment summary")).toContainText("Received so far$250.00");
    await expect(history.locator("li")).toHaveCount(2);

    const { data: event } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(event!.booking_confirmed_at).toBeNull();
    expect(event!.lifecycle_status).not.toBe("booked");
  });

  test("an invoice link must be https and is shown safely", async () => {
    const card = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Payments", { exact: true }) });
    await card.getByLabel("External invoice link (optional)").fill("http://invoice.example.com/42");
    await card.getByRole("button", { name: "Save invoice link" }).click();
    await expect(card.getByRole("alert")).toContainText("Enter a full https:// address");
    await card.getByLabel("External invoice link (optional)").fill("https://invoice.example.com/42");
    await card.getByRole("button", { name: "Save invoice link" }).click();
    await expect(card.getByText("Invoice link saved.")).toBeVisible();
    const link = card.getByRole("link", { name: "View invoice (invoice.example.com)" });
    await expect(link).toHaveAttribute("href", "https://invoice.example.com/42");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  test("once a contract is sent, its terms appear, labelled as not signed", async () => {
    await sendProposalFromEventPage(staff, tenant, eventId).then((url) => submitAsClient(tenant, url.split("/").pop()!));
    await staff.reload();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await staff.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    contractId = staff.url().split("/").pop()!;
    await staff.goto(eventUrl);
    // A draft is not authoritative.
    await expect(staff.getByText("No contract has been sent yet")).toBeVisible();
    await staff.goto(`/staff/${tenant.slug}/contracts/${contractId}/review`);
    await staff.getByRole("button", { name: "Send contract…" }).click();
    sentAt = Date.now();
    await staff.getByRole("dialog", { name: "Confirm sending the contract" }).getByRole("button", { name: "Send contract now" }).click();
    await staff.waitForURL(new RegExp(`/contracts/${contractId}$`));
    await staff.goto(eventUrl);
    const summary = staff.getByLabel("Payment summary");
    await expect(summary).toContainText("Terms of the contract sent to the client. It isn't signed yet");
    const { data: c } = await admin.from("contracts").select("total_cents, deposit_cents").eq("id", contractId).single();
    const money = (cents: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
    await expect(summary).toContainText(`Deposit still outstanding${money(c!.deposit_cents - 25000)}`);
    await expect(summary).toContainText(`Remaining balance${money(c!.total_cents - 25000)}`);
  });

  test("the verified client sees a read-only summary without staff-only details", async () => {
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
    const invite = new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await verifyContractInvitation(client, invite, clientEmail);
    await client.getByRole("button", { name: "Open my contract" }).click();
    await client.waitForURL(new RegExp(`/${tenant.slug}/contracts/${contractId}$`));

    const payments = client.getByRole("region", { name: "Payments" });
    await expect(payments).toContainText("Terms of the contract sent to you. It isn't signed yet.");
    await expect(payments).toContainText("Received so far$250.00");
    await expect(payments).toContainText("Payments are recorded by hand by");
    await expect(payments.getByRole("link", { name: "View invoice (invoice.example.com)" })).toHaveAttribute("href", "https://invoice.example.com/42");
    await expect(client.locator("body")).not.toContainText(/ET-STAFF-ONLY-123|Staff-only note|Recorded twice by mistake|Invalidate/);
    expect(await client.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("signing under the deposit policy awaits the deposit; recording it confirms the booking and emails the client", async () => {
    // The policy is explained in Settings (owner) and was frozen into the contract.
    await staff.goto(`/staff/${tenant.slug}/settings`);
    const policy = staff.locator("#booking");
    await expect(policy.getByRole("radio", { name: /signed and the deposit is received/ })).toBeChecked();
    await expect(policy).toContainText("Flux DJ confirms a booking automatically when this policy is met");

    // The client signs; $250 of the deposit was paid before signing.
    await client.getByLabel("Your full name").fill("Riley Park");
    await client.getByTestId("signature-canvas").scrollIntoViewIfNeeded();
    const box = (await client.getByTestId("signature-canvas").boundingBox())!;
    await client.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
    await client.mouse.down();
    for (let i = 1; i <= 30; i++) await client.mouse.move(box.x + box.width * (0.15 + 0.7 * (i / 30)), box.y + box.height * (0.5 + 0.25 * Math.sin(i / 3)));
    await client.mouse.up();
    await client.getByRole("checkbox").check();
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await client.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
    await expect(client.getByRole("heading", { name: "Contract signed." }).first()).toBeVisible();
    await client.reload();
    await expect(client.getByText(/Your booking will be confirmed once .* has recorded your deposit/)).toBeVisible();

    await staff.goto(eventUrl);
    await expect(staff.getByText("Signed · awaiting deposit").first()).toBeVisible();
    const booking = staff.getByLabel("Booking");
    await expect(booking).toContainText("The booking is confirmed automatically once valid payments reach the required deposit");
    const { data: c } = await admin.from("contracts").select("deposit_cents, total_cents, booking_policy").eq("id", contractId).single();
    expect(c!.booking_policy).toBe("on_deposit");
    const outstanding = c!.deposit_cents - 25000;
    const startedAt = Date.now();
    await staff.getByLabel(/Amount received/).fill((outstanding / 100).toFixed(2));
    await staff.getByRole("button", { name: "Record payment" }).click();
    await expect(staff.getByText("Payment recorded. The deposit is covered, so the booking is confirmed and the client is emailed.")).toBeVisible();
    await staff.reload();
    await expect(staff.getByText("Booked", { exact: true })).toBeVisible();
    await expect(staff.getByLabel("Booking")).toContainText("is still to be paid.");
    const { data: event } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(event!.lifecycle_status).toBe("booked");
    expect(event!.booking_confirmed_at).not.toBeNull();

    // One booking email, stating what remains; no planning promise.
    const mail = await waitForEmail(clientEmail, { after: startedAt, subject: /booking .* is confirmed/i });
    expect(mail.text).toContain("Still to pay:");
    expect(mail.text).not.toMatch(/planning/i);

    // Invalidating the payment that completed the deposit keeps the booking, with a warning.
    const history = staff.getByLabel("Payment history");
    await history.getByRole("button", { name: "Invalidate…" }).first().click();
    const dialog = staff.getByRole("dialog", { name: "Confirm invalidating the payment" });
    await dialog.getByLabel("Reason (required)").fill("Payment bounced");
    await dialog.getByRole("button", { name: "Invalidate payment" }).click();
    await expect(staff.getByLabel("Booking").getByRole("alert")).toContainText("The booking stands, but valid payments no longer cover the required deposit");
    expect((await admin.from("events").select("booking_confirmed_at").eq("id", eventId).single()).data!.booking_confirmed_at).toBe(event!.booking_confirmed_at);

    await client.reload();
    await expect(client.getByText("Your booking is confirmed.")).toBeVisible();
    await expect(client.getByRole("region", { name: "Payments" })).toContainText("Deposit still outstanding");
    await expect(client.locator("body")).not.toContainText(/Payment bounced|planning/i);
    await clientContext.close();
  });
});
