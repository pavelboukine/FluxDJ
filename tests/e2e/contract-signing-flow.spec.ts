/**
 * Contract signing in a real browser against local Supabase, in a dedicated
 * test tenant: staff send a DEMO contract, the client verifies and opens it
 * on a phone (touch input), draws, survives a rotation and a failed request
 * without losing anything, consents, confirms and signs; then the signed
 * state for the client and staff, and the paths a signed contract blocks.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-signing-${run}@example.test`;
const eventTitle = `E2E Signing Wedding ${run}`;
const BASE = "http://127.0.0.1:3000";

/** Ink pixels currently on the signature canvas. */
const inkOn = (page: Page) =>
  page.getByTestId("signature-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    return ink;
  });

/** Draws a signature-like stroke with real touch events (Chromium CDP). */
async function drawWithTouch(page: Page, context: BrowserContext) {
  const box = (await page.getByTestId("signature-canvas").boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = (t: number) => ({ x: box.x + box.width * (0.12 + 0.76 * t), y: box.y + box.height * (0.5 + 0.28 * Math.sin(t * 12)) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
  for (let i = 1; i <= 40; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(i / 40)] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.describe.serial("contract signing", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractId = "";
  let contractUrl = "";
  let sentAt = 0;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("signing", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Morgan Lee", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-10-02" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Parties", body: "{{business.legal_name}}\nClient: {{client.name}}" },
      { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
    ]);
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);

    const proposalUrl = await sendProposalFromEventPage(staff, tenant, eventId);
    await submitAsClient(tenant, proposalUrl.split("/").pop()!);
    await staff.reload();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await staff.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    contractUrl = staff.url();
    contractId = contractUrl.split("/").pop()!;
    await staff.getByRole("link", { name: "Review and send…" }).click();
    await staff.getByRole("button", { name: "Send contract…" }).click();
    sentAt = Date.now();
    await staff.getByRole("dialog", { name: "Confirm sending the contract" }).getByRole("button", { name: "Send contract now" }).click();
    await staff.waitForURL(contractUrl);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the verified signer opens the contract on a phone and sees the signing panel", async () => {
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
    const invite = new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    client = await clientContext.newPage();
    await client.goto(invite);
    const requested = Date.now();
    await client.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(client.getByText("Check your email.")).toBeVisible();
    const verify = await waitForEmail(clientEmail, { after: requested, subject: /Confirm your email/ });
    await client.goto(/(http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?\S+)/.exec(verify.text)![1]);
    await client.getByRole("button", { name: "Sign in" }).click();
    await client.getByRole("button", { name: "Open my contract" }).click();
    await client.waitForURL(new RegExp(`/${tenant.slug}/contracts/${contractId}$`));

    await expect(client.getByRole("heading", { level: 1 })).toHaveText(`DEMO, NOT FOR CLIENT USE: Agreement for ${eventTitle}`);
    await expect(client.locator("main")).toContainText("Deposit on signing (50%)");
    await expect(client.getByRole("heading", { name: "Sign this contract" })).toBeVisible();
    await expect(client.getByText(/have not been reviewed by a lawyer/)).toBeVisible();
    await expect(client.getByRole("checkbox")).not.toBeChecked();
    await expect(client.locator("body")).not.toContainText(/user agent|ip address|evidence/i);
    expect(await client.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("validation lists what is missing; drawing survives clearing, scrolling and rotation", async () => {
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await expect(client.getByRole("alert").filter({ hasText: "To sign" })).toHaveText("To sign, type your full name, draw your signature, check the consent box.");

    await client.getByTestId("signature-canvas").scrollIntoViewIfNeeded();
    await drawWithTouch(client, clientContext);
    expect(await inkOn(client)).toBeGreaterThan(500);
    await client.getByRole("button", { name: "Clear signature" }).click();
    expect(await inkOn(client)).toBe(0);
    await drawWithTouch(client, clientContext);
    const drawn = await inkOn(client);
    expect(drawn).toBeGreaterThan(500);

    await client.mouse.wheel(0, -400);
    await client.mouse.wheel(0, 400);
    expect(await inkOn(client)).toBe(drawn);
    // Rotate to landscape and back: strokes are rescaled, not lost.
    await client.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => inkOn(client)).toBeGreaterThan(500);
    await client.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => inkOn(client)).toBeGreaterThan(500);
    expect(await client.evaluate(() => Object.keys(localStorage).length)).toBe(0);
  });

  test("a failed request keeps the typed name, consent and drawing", async () => {
    await client.getByLabel("Your full name").fill("Morgan Lee");
    await client.getByRole("checkbox").check();
    const failOnce = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "POST") await route.abort("internetdisconnected");
      else await route.continue();
    };
    await client.route(`**/${tenant.slug}/contracts/${contractId}`, failOnce);
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await client.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
    await expect(client.getByRole("alert").filter({ hasText: "couldn't reach the server" })).toBeVisible();
    await client.unroute(`**/${tenant.slug}/contracts/${contractId}`, failOnce);

    await expect(client.getByLabel("Your full name")).toHaveValue("Morgan Lee");
    await expect(client.getByRole("checkbox")).toBeChecked();
    expect(await inkOn(client)).toBeGreaterThan(500);
    expect((await admin.from("contracts").select("status").eq("id", contractId).single()).data!.status).toBe("sent");
  });

  test("consent, explicit confirmation, then 'Contract signed.' without booking promises", async () => {
    await client.getByRole("checkbox").uncheck();
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await expect(client.getByRole("alert").filter({ hasText: "To sign" })).toHaveText("To sign, check the consent box.");
    await client.getByRole("checkbox").check();
    await client.getByRole("button", { name: "Review and sign…" }).click();
    const dialog = client.getByRole("dialog", { name: "Confirm signing" });
    await expect(dialog).toContainText("Sign this contract as Morgan Lee?");
    await dialog.getByRole("button", { name: "Sign contract" }).click();
    await expect(client.getByRole("heading", { name: "Contract signed." }).first()).toBeVisible();
    await expect(client.getByText("Your DJ will follow up with the next steps.").first()).toBeVisible();
    await expect(client.locator("body")).not.toContainText(/booked|planning|download/i);

    await client.reload();
    await expect(client.getByRole("heading", { name: "Contract signed." })).toBeVisible();
    await expect(client.getByText(/^Signed by Morgan Lee on /)).toBeVisible();
    await expect(client.getByRole("img", { name: "Signature of Morgan Lee" })).toBeVisible();
    await expect(client.getByRole("heading", { name: "Sign this contract" })).toHaveCount(0);
    await client.goto("/my");
    await expect(client.getByText(/Contract signed/)).toBeVisible();

    const { data: contract } = await admin.from("contracts").select("status, signed_at, content_sha256").eq("id", contractId).single();
    expect(contract!.status).toBe("signed");
    const { data: evidence } = await admin.from("contract_signatures").select("typed_name, signer_email, content_sha256, consent_version, client_ip, client_ip_source, user_agent").eq("contract_id", contractId).single();
    expect(evidence).toMatchObject({ typed_name: "Morgan Lee", signer_email: clientEmail, content_sha256: contract!.content_sha256, consent_version: "demo-v1", client_ip: null, client_ip_source: "unavailable" });
    expect(evidence!.user_agent).toBeTruthy();
    const { data: event } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(event).toEqual({ lifecycle_status: "awaiting_signature", booking_confirmed_at: null });
  });

  test("staff see the signed contract and evidence; void, resend and revisions are gone", async () => {
    await staff.goto(contractUrl);
    await expect(staff.getByText(/^Signed .* by Morgan Lee/)).toBeVisible();
    await expect(staff.getByRole("img", { name: "Signature of Morgan Lee" })).toBeVisible();
    await expect(staff.getByText("Matches this contract's content SHA-256.")).toBeVisible();
    await expect(staff.getByText(/Not available \(not reliably known/)).toBeVisible();
    await expect(staff.getByRole("button", { name: "Void…" })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Resend invitation" })).toHaveCount(0);

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    // The display reflects the signed contract; the stored lifecycle is unchanged and nothing is booked.
    await expect(staff.getByText("Contract signed · booking confirmation pending", { exact: true })).toBeVisible();
    await expect(staff.getByText("awaiting signature", { exact: true })).toHaveCount(0);
    await expect(staff.getByText("A contract has been signed for this event, so its terms can't be revised.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Start a revised offer" })).toHaveCount(0);
    await expect(staff.getByText(/was signed .*A signed contract can't be voided, replaced or revised/)).toBeVisible();
    await staff.goto(`/staff/${tenant.slug}/events`);
    await expect(staff.getByRole("row").filter({ hasText: eventTitle })).toContainText("Contract signed · booking confirmation pending");
    const { data: stored } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(stored).toEqual({ lifecycle_status: "awaiting_signature", booking_confirmed_at: null });
  });
});
