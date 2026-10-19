/**
 * A proposal discount in real browsers, in a dedicated test business: staff
 * choose a percentage in the builder and see it in the live preview before
 * saving (a fixed amount above the lowest package price is refused), save and
 * send; the client sees the offer, the discount row, the discounted subtotal,
 * the saving and the total on desktop and on a phone, and submits; staff see
 * the same figures, approve, and the contract and payment summary use the
 * discounted total.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff, signInWithLink, waitForEmail } from "./support";
import { must, sessionFor } from "./booking";
import { archiveTestTenant, createTestTenant, publishContractTemplate, type TestTenant } from "./tenant";

test.describe.serial("proposal discount", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let page: Page;
  const run = randomUUID().slice(0, 6);
  const clientEmail = `discount-client-${run}@example.test`;
  let eventId = "";
  let proposalUrl = "";
  let clientLink = "";
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2 })}`;
  const cad = (cents: number) => `${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2 })} CAD`;
  const noSideways = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("discount", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam & Alex", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Discount Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("builder: a discount shows in the live preview before saving; limits are explained; it saves and sends", async () => {
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await page.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
    await page.getByRole("button", { name: "Start proposal draft" }).click();
    await page.waitForURL("**/proposals/**");
    proposalUrl = page.url();
    const editor = page.getByTestId("discount-editor");
    const preview = page.getByRole("region", { name: "Client preview (scrolls separately)" });
    await expect(editor.getByLabel("No discount")).toBeChecked();
    await expect(preview.getByTestId("price-discount")).toHaveCount(0);

    // A fixed amount above the lowest subtotal a client can choose ($1,500.00 here: every charge can be avoided) is refused.
    await editor.getByLabel("Fixed amount").check();
    await editor.getByLabel("Amount off (CAD)").fill("1500.01");
    await expect(editor.getByRole("alert")).toHaveText("The discount amount can't be more than the lowest possible subtotal of this proposal.");
    await expect(editor).toContainText("Up to $1,500.00, the lowest subtotal a client can choose");
    // A custom Essential price moves the limit at once.
    await page.getByTestId("package-slot").nth(0).getByRole("button", { name: "Edit price of Essential for this proposal" }).click();
    await page.getByTestId("package-slot").nth(0).getByLabel("This proposal (CAD)").fill("1600");
    await expect(editor).toContainText("Up to $1,600.00, the lowest subtotal a client can choose");
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await page.getByTestId("package-slot").nth(0).getByRole("button", { name: "Reset Essential to the standard price" }).click();
    // The preview shows the database's refusal, with the exact limit.
    await expect(page.getByText("the fixed discount can't be more than the lowest possible subtotal of this proposal (1,500.00 CAD)")).toBeVisible();

    await editor.getByLabel("Percentage").check();
    await editor.getByLabel("Percent off").fill("10");
    await editor.getByLabel("Description (optional)").fill("Wedding Special");
    await expect(page.getByTestId("preview-status")).toContainText("Showing your unsaved changes");
    await expect(preview.getByTestId("offer-discount")).toHaveText("Wedding Special: 10% off your total, applied before taxes.");
    await expect(preview.getByTestId("price-discount")).toContainText("Wedding Special (10%)");
    await expect(preview.getByTestId("price-savings")).toContainText("You save");

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    const { data: draft } = await must(admin.from("proposals").select("draft_offer").eq("event_id", eventId).single());
    expect((draft!.draft_offer as { discount: unknown }).discount).toEqual({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" });

    const sentAt = Date.now();
    await page.getByRole("button", { name: "Review and send…" }).click();
    await page.getByRole("dialog", { name: "Confirm sending" }).getByRole("button", { name: "Send proposal now" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    const { data: sent } = await must(admin.from("proposals").select("offer_snapshot").eq("event_id", eventId).single());
    expect((sent!.offer_snapshot as { discount: unknown }).discount).toEqual({ type: "percent", percent_basis_points: 1000, label: "Wedding Special" });
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    // The proposal email adds no promotional wording (the event title and the business's link say "discount").
    const prose = email.text.replaceAll(`E2E Discount Wedding ${run}`, "").replace(/https?:\/\/\S+/g, "");
    expect(prose).not.toMatch(/special|you save|discount|% off/i);
    clientLink = new RegExp(`(http://127\\.0\\.0\\.1:3000/${tenant.slug}/p#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
  });

  test("client: the offer, the discount, the discounted subtotal, the saving and the total, on a phone too; submit", async () => {
    const client = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await client.goto(clientLink);
    await client.waitForURL(new RegExp(`/${tenant.slug}/proposals/[0-9a-f-]{36}$`));
    await expect(client.getByTestId("offer-discount")).toHaveText("Wedding Special: 10% off your total, applied before taxes.");
    await client.getByRole("group", { name: /ceremony take place/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /cocktail hour/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /speeches/i }).getByLabel("No").check();
    const summary = client.locator("#price-summary");
    await expect(summary.getByTestId("price-discount")).toContainText("Wedding Special (10%)");
    await expect(summary).toContainText("Subtotal after discount");
    await expect(client.getByText("All changes saved")).toBeVisible();

    // A phone: everything fits, the offer and the saving stay visible.
    await client.setViewportSize({ width: 375, height: 812 });
    await expect(client.getByTestId("offer-discount")).toBeVisible();
    await expect(summary.getByTestId("price-savings")).toContainText("You save");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    await client.setViewportSize({ width: 1440, height: 1000 });

    await client.getByRole("button", { name: "Review proposal" }).click();
    await expect(client.getByRole("heading", { name: "Review your choices" })).toBeVisible();
    await expect(client.getByTestId("price-discount")).toContainText("Wedding Special (10%)");
    await client.getByRole("button", { name: "Submit proposal" }).click();
    await expect(client.getByText("Submitted for DJ review.")).toBeVisible();

    const { data: selection } = await must(
      admin.from("proposal_selections").select("subtotal_cents, discount_cents, total_cents, proposals!inner(event_id)").eq("proposals.event_id", eventId).single(),
    );
    expect(selection!.discount_cents).toBe(Math.round(selection!.subtotal_cents / 10));
    await client.goto(client.url());
    await expect(client.locator("body")).toContainText(usd(selection!.total_cents));
    await client.context().close();
  });

  test("staff: the same figures, approval, a contract and a payment summary from the discounted total", async () => {
    const { data: selection } = await must(
      admin.from("proposal_selections").select("subtotal_cents, discount_cents, total_cents, proposals!inner(event_id)").eq("proposals.event_id", eventId).single(),
    );
    const { subtotal_cents: subtotal, discount_cents: discount, total_cents: total } = selection!;
    const deposit = Number((BigInt(total) * BigInt(5000) + BigInt(5000)) / BigInt(10000));
    const templateName = `E2E Discount Terms ${run}`;
    await publishContractTemplate(tenant, templateName, "DEMO agreement for {{event.title}}", [
      { heading: "Price", body: "{{pricing.subtotal_before_discount}} before discount. {{pricing.discount}}. Subtotal {{pricing.subtotal}}. Total {{pricing.total}}. Deposit {{payment.deposit}}." },
    ]);

    await page.goto(proposalUrl);
    await expect(page.getByTestId("price-discount").first()).toContainText(`−${usd(discount)}`);
    await page.getByRole("button", { name: "Approve…" }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm approval" });
    await expect(confirm).toContainText(usd(total));
    await confirm.getByRole("button", { name: "Approve selection" }).click();
    await expect(page.getByText(/Next: generate the contract draft\. The event is not booked\./)).toBeVisible();

    await page.getByLabel("Template version").selectOption({ label: `${templateName} · version 1 · DEMO (latest published)` });
    await page.getByRole("button", { name: "Generate contract draft" }).click();
    await page.waitForURL(new RegExp(`/staff/${tenant.slug}/contracts/[0-9a-f-]{36}$`));
    await expect(page.locator("article")).toContainText(
      `${cad(subtotal)} before discount. Wedding Special (10%): -${cad(discount)}. Subtotal ${cad(subtotal - discount)}. Total ${cad(total)}. Deposit ${cad(deposit)}.`,
    );

    // Sent to the client (as the send action does), the payment summary shows the agreed, discounted price.
    const { data: contract } = await must(admin.from("contracts").select("id, total_cents, deposit_cents").eq("event_id", eventId).single());
    expect(contract).toMatchObject({ total_cents: total, deposit_cents: deposit });
    const staffDb = await sessionFor(tenant.ownerEmail);
    const linkId = randomUUID();
    await must(staffDb.rpc("send_contract", { p_contract_id: contract!.id, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
    await page.goto(`/staff/${tenant.slug}/events/${eventId}#payments`);
    const payments = page.locator("#payments");
    await expect(payments).toContainText(`Original subtotal${usd(subtotal)}`);
    await expect(payments).toContainText(`Wedding Special (10%)−${usd(discount)}`);
    await expect(payments).toContainText(`Subtotal after discount${usd(subtotal - discount)}`);
    await expect(payments).toContainText("GST (5%)");
    await expect(payments).toContainText(`Agreed total, including taxes${usd(total)}`);
    await expect(payments).toContainText(`Deposit required (50%)${usd(deposit)}`);

    // The client's contract page shows the same frozen breakdown with their payment terms.
    const client = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInWithLink(client, clientEmail);
    const clientDb = await sessionFor(clientEmail);
    await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
    await client.goto(`/${tenant.slug}/contracts/${contract!.id}`);
    const terms = client.locator("#payments");
    await expect(terms).toContainText(`Original subtotal${usd(subtotal)}`);
    await expect(terms.getByTestId("payment-discount")).toHaveText(`Wedding Special (10%)−${usd(discount)}`);
    await expect(terms).toContainText(`Subtotal after discount${usd(subtotal - discount)}`);
    await expect(terms).toContainText(`Agreed total, including taxes${usd(total)}`);
    await expect(terms).toContainText(`Deposit on signing (50%)${usd(deposit)}`);
    await client.setViewportSize({ width: 375, height: 812 });
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    await client.context().close();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/staff/${tenant.slug}/events/${eventId}#payments`);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
    await page.goto(proposalUrl);
    expect(await noSideways(page)).toBeLessThanOrEqual(0);
  });
});
