/**
 * Contract sending and verified client onboarding in real browsers, against
 * local Supabase Auth and Mailpit, inside a dedicated test tenant:
 * staff send -> contract email -> invitation page -> verification email ->
 * explicit Sign in (another browser, JavaScript off) -> Open my contract ->
 * read-only contract; then wrong accounts, returning login and void.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, expectLinkRequested, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-signer-${run}@example.test`;
const eventTitle = `E2E Send Wedding ${run}`;
const BASE = "http://127.0.0.1:3000";

test.describe.serial("contract sending and verified client access", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let eventId = "";
  let contractUrl = "";
  let clientContractUrl = "";
  let sentAt = 0;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("send", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sasha & Remy", email: clientEmail });
    await admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-09-25",
      internal_notes: `E2E staff-only note ${run}`,
    });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
      { heading: "Parties", body: "{{business.legal_name}}, {{business.address}}\nClient: {{client.name}}" },
      { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
    ]);
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("staff send the reviewed contract; it is frozen, invited and emailed, not booked", async () => {
    const proposalUrl = await sendProposalFromEventPage(staff, tenant, eventId);
    await submitAsClient(tenant, proposalUrl.split("/").pop()!);
    await staff.reload();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await staff.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    contractUrl = staff.url();
    const contractId = contractUrl.split("/").pop()!;
    const { data: before } = await admin.from("contracts").select("content_sha256").eq("id", contractId).single();

    await staff.getByRole("link", { name: "Review and send…" }).click();
    await staff.getByRole("button", { name: "Send contract…" }).click();
    const dialog = staff.getByRole("dialog", { name: "Confirm sending the contract" });
    await expect(dialog).toContainText(clientEmail);
    sentAt = Date.now();
    await dialog.getByRole("button", { name: "Send contract now" }).click();
    await staff.waitForURL(contractUrl);
    await expect(staff.getByText(/^Sent .* to Sasha & Remy/)).toBeVisible();

    const { data: after } = await admin.from("contracts").select("status, content_sha256, sent_at").eq("id", contractId).single();
    expect(after).toMatchObject({ status: "sent", content_sha256: before!.content_sha256 });
    const { data: event } = await admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single();
    expect(event).toEqual({ lifecycle_status: "awaiting_signature", booking_confirmed_at: null });
  });

  test("the invitation alone shows nothing private and grants nothing", async () => {
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
    const invite = new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    expect(email.text).toContain("you will confirm your email address before you can open it.");

    const deviceA = await browser.newContext();
    const a = await deviceA.newPage();
    await a.goto(invite);
    await expect(a.getByText(`Your contract from ${tenant.displayName}`)).toBeVisible();
    await expect(a).toHaveURL(`${BASE}/${tenant.slug}/invite`); // token removed from the address bar
    await expect(a.locator("body")).not.toContainText(eventTitle);
    const { count } = await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(count).toBe(0);

    const requested = Date.now();
    await a.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expectLinkRequested(a, "Check your email.", { bucket: "contract_sign_in", windowSeconds: 900 });
    await expect(a.getByText(/to e•••@example\.test/)).toBeVisible();
    const verify = await waitForEmail(clientEmail, { after: requested, subject: /Confirm your email to read your contract/ });
    process.env.E2E_VERIFY_LINK = /(http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?\S+)/.exec(verify.text)![1];
    await deviceA.close();
  });

  test("on another device with JavaScript off, the client confirms, signs in, opens and reads the contract", async () => {
    const link = process.env.E2E_VERIFY_LINK!;
    const deviceB = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const b = await deviceB.newPage();
    await b.goto(link);
    await expect(b.getByText("Confirm to verify your email and continue to your contract on this device.")).toBeVisible();
    // Opening the verification link signs nothing in and grants nothing.
    const scanner = await browser.newContext();
    await (await scanner.newPage()).goto(link);
    await scanner.close();
    expect((await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId)).count).toBe(0);

    const post = b.waitForRequest((r) => r.method() === "POST" && r.url().includes("/auth/confirm"));
    await b.getByRole("button", { name: "Sign in" }).click();
    const headers = await (await post).allHeaders();
    expect(headers.origin).toBe(BASE);
    expect(headers.referer ?? "").not.toContain("token_hash");
    await b.waitForURL(new RegExp(`/${tenant.slug}/invitations/[0-9a-f-]{36}$`));
    await expect(b.getByText(/Your email is confirmed/)).toBeVisible();
    expect((await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId)).count).toBe(0);

    await b.getByRole("button", { name: "Open my contract" }).click();
    await b.waitForURL(new RegExp(`/${tenant.slug}/contracts/[0-9a-f-]{36}$`));
    clientContractUrl = b.url();
    await expect(b.getByRole("heading", { level: 1 })).toHaveText(`DEMO, NOT FOR CLIENT USE: Agreement for ${eventTitle}`);
    await expect(b.getByText("DEMO, NOT FOR CLIENT USE. This is test wording, not a real agreement.")).toBeVisible();
    // JavaScript is off here: the agreement is fully readable; signing itself is covered by contract-signing-flow.spec.ts.
    await expect(b.getByRole("heading", { name: "Sign this contract" })).toBeVisible();
    await expect(b.locator("main")).toContainText("Deposit on signing (50%)");
    await expect(b.locator("body")).not.toContainText(`E2E staff-only note ${run}`);
    expect(await b.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const fontSize = await b.locator("article p").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);

    const { data: access } = await admin.from("event_access").select("client_id, revoked_at").eq("event_id", eventId);
    expect(access).toHaveLength(1);
    const { data: user } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const identity = user.users.find((u) => u.email === clientEmail)!;
    expect(identity.email_confirmed_at).toBeTruthy();
    expect((await admin.from("tenant_memberships").select("id", { count: "exact", head: true }).eq("user_id", identity.id)).count).toBe(0);
    await deviceB.close();
  });

  test("another signed-in account cannot open the invitation or read the contract", async () => {
    const linkId = (await admin.from("access_links").select("id").eq("purpose", "contract").eq("tenant_id", tenant.id).single()).data!.id;
    await staff.goto(`/${tenant.slug}/invitations/${linkId}`);
    await expect(staff.getByText(new RegExp(`You're signed in as ${tenant.ownerEmail.replace(/[.]/g, "\\.")}, but this contract was sent to e•••@example\\.test`))).toBeVisible();
    await expect(staff.locator("body")).not.toContainText(eventTitle);
    await staff.goto(clientContractUrl);
    await expect(staff.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
    const anonymous = await browser.newContext();
    const anon = await anonymous.newPage();
    await anon.goto(clientContractUrl);
    await expect(anon.getByRole("heading", { name: "Sign in to read your contract" })).toBeVisible();
    await anonymous.close();
  });

  test("a returning client signs in with a magic link and finds the contract", async () => {
    const returning = await browser.newContext();
    const page = await returning.newPage();
    // The same magic-link login form as staff; with no staff role, the client lands on their contracts.
    const started = Date.now();
    await page.goto("/login");
    await page.getByLabel("Email").fill(clientEmail);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expectLinkRequested(page, /If that email has a Flux DJ account/, { bucket: "sign_in_link", windowSeconds: 600 });
    const message = await waitForEmail(clientEmail, { after: started, subject: /sign-in link/ });
    await page.goto(/href="([^"]+\/auth\/confirm[^"]+)"/.exec(message.html)![1].replaceAll("&amp;", "&"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/my");
    await page.getByRole("link", { name: eventTitle }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(eventTitle);

    // Staff void it: the signed-in client can no longer read it, and keeps nothing else.
    await staff.goto(contractUrl);
    await staff.getByRole("button", { name: "Void…" }).click();
    await staff.getByLabel("Reason (kept in the record)").fill("Wrong date");
    await staff.getByRole("button", { name: "Void contract" }).click();
    await expect(staff.getByText(/Voided .*: Wrong date/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
    await page.goto("/my");
    // The event stays listed (the client keeps event access), but no contract can be opened.
    await expect(page.getByRole("heading", { name: eventTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: /contract/i })).toHaveCount(0);
    await returning.close();
  });
});
