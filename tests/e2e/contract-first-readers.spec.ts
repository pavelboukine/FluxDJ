/**
 * Existing pages reading a direct contract (no proposal, no financial terms),
 * in real browsers against local Supabase. The contract is inserted with the
 * service role, through the real triggers and constraints; booking-workflows.spec.ts
 * creates them through the screens. Dedicated test business:
 *   - the client's invitation, contract page and event hub show no proposal link and no money, and signing books;
 *   - staff see the contract, its review and the event's payments with no invented figures and no proposal link.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { must, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, type TestTenant } from "./tenant";

test.describe.configure({ mode: "serial" });

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-cfread-${run}@example.test`;
let tenant: TestTenant;
let eventId: string;
let contractId: string;
let inviteToken: string;
const MONEY = /Paid in full|No payment due|\$\s?0\.00|0\.00\s?\$|Total, including|Deposit on signing|Approved selection/;

test.beforeAll(async () => {
  tenant = await createTestTenant("cfread", { catalog: true });
  const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
  const versionId = await publishContractTemplate(tenant, "Direct (DEMO)", "DEMO, NOT FOR CLIENT USE: Direct agreement", [{ heading: "Terms", body: "Between {{business.legal_name}} and {{client.name}}." }]);
  const { data: version } = await must(admin.from("contract_template_versions").select("template_id, content_sha256").eq("id", versionId).single());
  const { data: t } = await must(admin.from("tenants").select("business_name, display_name, business_address, contact_email").eq("id", tenant.id).single());

  eventId = randomUUID();
  const clientId = randomUUID();
  await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Direct Client", email: clientEmail }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: "Direct event", event_type: "wedding", event_date: "2027-09-18", contract_first: true }));
  await must(admin.from("events").update({ lifecycle_status: "awaiting_signature" }).eq("id", eventId));
  await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  // Inserted with the service role, which can't override the business's required
  // deposit: only a signed-in owner can. So the fixture lifts the requirement.
  await must(admin.from("tenants").update({ booking_confirmation_policy: "on_signature" }).eq("id", tenant.id));
  const { data: contract } = await must(
    admin.from("contracts").insert({
      tenant_id: tenant.id, event_id: eventId, template_id: version!.template_id, template_version_id: versionId, template_content_sha256: version!.content_sha256,
      signer_client_id: clientId, signer_name: "Direct Client", signer_email: clientEmail, currency: "CAD", booking_policy: "on_signature",
      rendered_content: { schema_version: 1, title: "DEMO, NOT FOR CLIENT USE: Direct agreement", sections: [{ heading: "Terms", body: "We agree to the event." }] },
      commercial_snapshot: { schema_version: 2, financial_terms: "none" },
      party_snapshot: {
        business: { name: t!.business_name, display_name: t!.display_name, legal_name: t!.business_name, address: t!.business_address, contact_email: t!.contact_email },
        client: { client_id: clientId, name: "Direct Client", email: clientEmail, phone: null },
        event: { event_id: eventId, title: "Direct event", event_type: "wedding", date: "2027-09-18", timezone: "America/Toronto", venue_name: null, venue_address: null },
      },
      content_sha256: "0".repeat(64), generated_by_user_id: owner!.user_id,
    }).select("id").single(),
  );
  contractId = contract!.id;
  await must(admin.from("tenants").update({ booking_confirmation_policy: "on_deposit" }).eq("id", tenant.id));
  const staffDb = await sessionFor(tenant.ownerEmail);
  const linkId = randomUUID();
  inviteToken = randomBytes(32).toString("base64url");
  await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(inviteToken).digest("hex") }));
  await must(admin.auth.admin.createUser({ email: clientEmail, email_confirm: true }));
  const clientDb = await sessionFor(clientEmail);
  await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
});

test.afterAll(async () => {
  await archiveTestTenant(tenant);
});

test("a direct contract's invitation link shows the business", async ({ page }) => {
  await page.goto(`/${tenant.slug}/invite#${inviteToken}`);
  await expect(page.getByText(tenant.displayName).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("isn't available any more");
});

test("staff read a sent direct contract with no invented figures or proposal link", async ({ page }) => {
  await signInStaff(page, tenant.ownerEmail);
  await page.goto(`/staff/${tenant.slug}/contracts/${contractId}`);
  await expect(page.getByTestId("contract-no-terms")).toBeVisible();
  await expect(page.getByRole("link", { name: "Approved proposal" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(MONEY);
  await expect(page.locator("a[href*='/proposals/null']")).toHaveCount(0);

  await page.goto(`/staff/${tenant.slug}/contracts/${contractId}/review`);
  await expect(page.getByTestId("contract-no-terms")).toBeVisible();

  await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
  await expect(page.getByTestId("payments-no-terms")).toBeVisible();
  await expect(page.getByTestId("payment-figures")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/Paid in full/);
});

test("the client reads and signs it, with no proposal link and no money, and the event is booked", async ({ page }) => {
  await signInWithLink(page, clientEmail, `/${tenant.slug}/events/${eventId}`);
  await expect(page.getByTestId("hub-booking")).toBeVisible();
  await expect(page.getByTestId("hub-booking")).not.toContainText("Approved proposal");
  await expect(page.locator("main")).not.toContainText(MONEY);
  await expect(page.getByText("Read the agreement from")).toBeVisible();

  // There is no proposal page to land on.
  await page.goto(`/${tenant.slug}/events/${eventId}/proposal`);
  await expect(page).toHaveURL(new RegExp(`/${tenant.slug}/events/${eventId}$`));

  await page.goto(`/${tenant.slug}/contracts/${contractId}`);
  await expect(page.getByText("We agree to the event.")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(MONEY);
  await expect(page.getByText("then sign at the end of this page")).toContainText("read the agreement, then sign");
  await expect(page.locator("#payments")).toHaveCount(0);

  await page.getByLabel("Your full name").fill("Direct Client");
  await page.getByTestId("signature-canvas").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("signature-canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + box.width * (0.12 + 0.025 * i), box.y + box.height * (0.5 + 0.25 * Math.sin(i / 2.5)));
  await page.mouse.up();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review and sign…" }).click();
  await page.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();

  const outcome = page.getByTestId("signed-outcome");
  await expect(outcome).toHaveAttribute("data-state", "booked");
  await expect(page.locator("#payments")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(MONEY);
  const { data: event } = await must(admin.from("events").select("lifecycle_status, booking_confirmed_at").eq("id", eventId).single());
  expect(event!.lifecycle_status).toBe("booked");
  expect(event!.booking_confirmed_at).not.toBeNull();
});
