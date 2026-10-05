/**
 * The owner publishes their own agreement for client use through the template
 * editor (with the responsibility confirmation), generates and sends a
 * contract from it, and the verified client signs it with the client-v1
 * consent. Nothing is labelled DEMO, and the signed PDF says only the client
 * signed. Dedicated test tenant; staff and client use separate browsers.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { pdfPageTexts } from "../support/pdf";
import { admin, MAILPIT, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-real-${run}@example.test`;
const eventTitle = `E2E Real Wedding ${run}`;
const templateName = `Our agreement ${run}`;
const BASE = "http://127.0.0.1:3000";
const AGREEMENT = "## Parties\n{{business.legal_name}} and {{client.name}}.\n\n## Payment\nTotal {{pricing.total}}. Deposit: {{payment.deposit}}.";
const CLIENT_V1 =
  "I have read the entire agreement shown above, including its payment terms. I agree to sign it electronically. I agree that my typed name " +
  "and drawn signature are my signature on this agreement and that they bind me to it as a handwritten signature would. I can download a " +
  "copy of the signed agreement here, and a copy will be emailed to me.";

/** The newest PDF attachment emailed to `to` with a matching subject. */
async function pdfEmailedTo(to: string, subject: RegExp): Promise<Buffer> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const search = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
    const hit = search.messages.find((m) => subject.test(m.Subject));
    if (hit) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Attachments: { PartID: string; ContentType: string }[] };
      const part = message.Attachments.find((a) => a.ContentType === "application/pdf")!;
      return Buffer.from(await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}/part/${part.PartID}`)).arrayBuffer());
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} matching ${subject}`);
}

test.describe.serial("client-use agreements", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractId = "";
  let sentAt = 0;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("real", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Avery Quinn", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-10-09" });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the owner publishes their own agreement for client use only after confirming responsibility", async () => {
    await staff.goto(`/staff/${tenant.slug}/contract-templates`);
    await expect(staff.getByText(/Flux DJ does not review it/)).toBeVisible();
    await staff.getByLabel("Template name").fill(templateName);
    await staff.getByLabel("Document title").fill("Services agreement for {{event.title}}");
    await staff.getByLabel("Sections").fill(AGREEMENT);
    await staff.getByRole("button", { name: "Create template draft" }).click();
    await staff.waitForURL(/\/contract-templates\/[0-9a-f-]{36}$/);

    await staff.getByRole("button", { name: "Publish…" }).click();
    const dialog = staff.getByRole("dialog", { name: "Confirm publishing" });
    await expect(dialog.getByRole("radio", { name: /For client use/ })).toBeChecked();
    const confirm = dialog.getByRole("checkbox");
    await expect(confirm).not.toBeChecked();
    await expect(dialog).toContainText("I am responsible for this agreement and its wording, and I approve this version for use with my clients.");
    await expect(dialog).toContainText("Flux DJ has not reviewed or approved this agreement and does not provide legal advice.");
    await expect(dialog).not.toContainText(/reviewed by a lawyer|certified/i);
    const publish = dialog.getByRole("button", { name: "Publish version 1 for client use" });
    await expect(publish).toBeDisabled();
    await confirm.check();
    await publish.click();

    await expect(staff.getByText("Version 1 published for client use.")).toBeVisible();
    await expect(staff.getByText(/Approved for client use by the owner on /)).toBeVisible();
    const { data: version } = await admin
      .from("contract_template_versions")
      .select("usage, client_use_statement_version, client_use_confirmed_at, client_use_confirmed_by_user_id, published_at")
      .eq("tenant_id", tenant.id)
      .single();
    const { data: owner } = await admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single();
    expect(version).toMatchObject({ usage: "client_use", client_use_statement_version: "client-use-v1", client_use_confirmed_by_user_id: owner!.user_id });
    expect(version!.client_use_confirmed_at).toBe(version!.published_at);
    // Publishing sent and signed nothing.
    expect((await admin.from("contracts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id)).count).toBe(0);
  });

  test("staff generate and send a client-use contract", async () => {
    const proposalUrl = await sendProposalFromEventPage(staff, tenant, eventId);
    await submitAsClient(tenant, proposalUrl.split("/").pop()!);
    await staff.reload();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await staff.getByLabel("Template version").selectOption({ label: `${templateName} · version 1 · client use (latest published)` });
    await staff.getByRole("button", { name: "Generate contract draft" }).click();
    await staff.waitForURL(/\/contracts\/[0-9a-f-]{36}$/);
    contractId = staff.url().split("/").pop()!;
    await expect(staff.getByText("Client use", { exact: true })).toBeVisible();
    await staff.getByRole("link", { name: "Review and send…" }).click();
    await staff.getByRole("button", { name: "Send contract…" }).click();
    sentAt = Date.now();
    await staff.getByRole("dialog", { name: "Confirm sending the contract" }).getByRole("button", { name: "Send contract now" }).click();
    await staff.waitForURL(new RegExp(`/contracts/${contractId}$`));
    expect((await admin.from("contracts").select("signing_mode, consent_version").eq("id", contractId).single()).data).toEqual({
      signing_mode: "client_use",
      consent_version: "client-v1",
    });
  });

  test("the verified client signs with the client-v1 consent and sees no DEMO wording", async () => {
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent your contract/ });
    const invite = new RegExp(`(${BASE}/${tenant.slug}/invite#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    clientContext = await browser.newContext();
    client = await clientContext.newPage();
    await client.goto(invite);
    const requested = Date.now();
    await client.getByRole("button", { name: "Email me a sign-in link" }).click();
    const verify = await waitForEmail(clientEmail, { after: requested, subject: /Confirm your email/ });
    await client.goto(/(http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?\S+)/.exec(verify.text)![1]);
    await client.getByRole("button", { name: "Sign in" }).click();
    await client.getByRole("button", { name: "Open my contract" }).click();
    await client.waitForURL(new RegExp(`/${tenant.slug}/contracts/${contractId}$`));

    await expect(client.getByRole("heading", { level: 1 })).toHaveText(`Services agreement for ${eventTitle}`);
    await expect(client.getByRole("heading", { name: "Sign this contract" })).toBeVisible();
    await expect(client.locator("body")).not.toContainText(/DEMO|NOT FOR CLIENT USE|reviewed by a lawyer|isn.t available/i);
    const consent = client.getByRole("checkbox");
    await expect(consent).not.toBeChecked();
    await expect(client.locator("label").filter({ has: consent })).toHaveText(CLIENT_V1);

    await client.getByLabel("Your full name").fill("Avery Quinn");
    await client.getByTestId("signature-canvas").scrollIntoViewIfNeeded();
    const box = (await client.getByTestId("signature-canvas").boundingBox())!;
    await client.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
    await client.mouse.down();
    for (let i = 1; i <= 30; i++) await client.mouse.move(box.x + box.width * (0.15 + 0.7 * (i / 30)), box.y + box.height * (0.5 + 0.25 * Math.sin(i / 3)));
    await client.mouse.up();
    await consent.check();
    await client.getByRole("button", { name: "Review and sign…" }).click();
    await client.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
    await expect(client.getByRole("heading", { name: "Contract signed." }).first()).toBeVisible();

    const { data: evidence } = await admin.from("contract_signatures").select("consent_version, consent_text").eq("contract_id", contractId).single();
    expect(evidence).toEqual({ consent_version: "client-v1", consent_text: CLIENT_V1 });
    const { data: event } = await admin.from("events").select("lifecycle_status").eq("id", eventId).single();
    expect(event!.lifecycle_status).toBe("awaiting_deposit");
  });

  test("the signed PDF has no DEMO labels and records only the client's signature", async () => {
    const pdf = await pdfEmailedTo(clientEmail, /Your signed contract/);
    const pages = await pdfPageTexts(pdf);
    const text = pages.join(" ");
    expect(text).not.toMatch(/DEMO|NOT FOR CLIENT USE/);
    expect(text).toContain(`Services agreement for ${eventTitle}`);
    expect(text).toContain("Consent (client-v1)");
    expect(text).toContain("This document records the client's electronic signature only.");
    await clientContext.close();
  });
});
