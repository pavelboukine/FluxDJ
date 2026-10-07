/**
 * Invite-only DJ onboarding in real browsers, against local Supabase Auth and
 * Mailpit: a platform administrator invites a DJ -> invitation email -> /join
 * -> verification email -> explicit Sign in on a phone-sized browser -> name
 * the business and its address -> the new, empty staff workspace. Then
 * ordinary owners and anonymous visitors, a wrong account and revocation.
 *
 * The operator is a throwaway @example.test user granted through the same SQL
 * function as the hosted one-time grant. This spec is the only one that uses
 * the /join request form and its per-IP "platform_sign_in" limit (2 per run).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, expectLinkRequested, signInStaff, signInWithLink, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

const run = randomUUID().slice(0, 6);
const operatorEmail = `e2e-operator-${run}@example.test`;
const djEmail = `e2e-maxwell-${run}@example.test`;
const otherEmail = `e2e-other-dj-${run}@example.test`;
const slug = `e2e-maxwell-${run}`;
const SIGN_IN_LIMIT = { bucket: "platform_sign_in", windowSeconds: 900 };

test.describe.serial("invite-only DJ onboarding", () => {
  let browser: Browser;
  let existing: TestTenant;
  let operator: Page;
  let dj: Page;
  let invitationLink = "";
  let invitationId = "";
  let createdTenantId: string | undefined;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    existing = await createTestTenant("onboard");
    const created = await admin.auth.admin.createUser({ email: operatorEmail, email_confirm: true });
    if (created.error) throw created.error;
    grantPlatformAdminLocally(operatorEmail);
    operator = await (await browser.newContext()).newPage();
    await signInWithLink(operator, operatorEmail, "/platform/invitations");
    await operator.waitForURL("**/platform/invitations");
  });

  test.afterAll(async () => {
    const { data: operatorUser } = await admin.from("platform_invitations").select("invited_by").in("email", [djEmail, otherEmail]).limit(1).maybeSingle();
    if (operatorUser?.invited_by) {
      await admin.from("platform_invitations").update({ revoked_at: new Date().toISOString(), revoked_by: operatorUser.invited_by })
        .in("email", [djEmail, otherEmail]).is("accepted_at", null).is("revoked_at", null);
    }
    revokePlatformAdminLocally(operatorEmail);
    await archiveTestTenant(existing);
    if (createdTenantId) await admin.from("tenants").update({ archived_at: new Date().toISOString() }).eq("id", createdTenantId);
  });

  test("ordinary owners and signed-out visitors cannot open the invitations screen", async () => {
    const owner = await (await browser.newContext()).newPage();
    await signInStaff(owner, existing.ownerEmail);
    await expect(owner.getByRole("link", { name: "DJ invitations" })).toHaveCount(0);
    await owner.goto("/platform/invitations");
    await expect(owner.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await owner.context().close();

    const anonymous = await (await browser.newContext()).newPage();
    await anonymous.goto("/platform/invitations");
    await anonymous.waitForURL("**/login");
    await anonymous.context().close();
  });

  test("the operator reviews the recipient and expiry, then sends the invitation", async () => {
    await operator.getByLabel("DJ's email address").fill(`  ${djEmail.toUpperCase()} `);
    await operator.getByRole("button", { name: "Review invitation" }).click();
    const review = operator.getByRole("dialog", { name: "Review the invitation" });
    await expect(review).toContainText(`Recipient: ${djEmail}`);
    await expect(review).toContainText(/Expires: .+ \(14 days\)/);
    const sentAt = Date.now();
    await review.getByRole("button", { name: "Send invitation" }).click();
    await expect(operator.getByRole("status").filter({ hasText: `Invitation sent to ${djEmail}` })).toBeVisible();
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: djEmail })).toContainText("Pending");

    // A second invitation to the same address is refused with a pointer to Resend.
    await operator.getByRole("button", { name: "Invite another DJ" }).click();
    await operator.getByLabel("DJ's email address").fill(djEmail);
    await operator.getByRole("button", { name: "Review invitation" }).click();
    await operator.getByRole("button", { name: "Send invitation" }).click();
    await expect(operator.getByRole("alert").filter({ hasText: "already has a pending invitation" })).toBeVisible();
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: djEmail })).toHaveCount(1);

    const email = await waitForEmail(djEmail, { after: sentAt, subject: /invited to set up your DJ business/ });
    invitationLink = /(http:\/\/\S+\/join#\S+)/.exec(email.text)![1];
    const { data } = await admin.from("platform_invitations").select("id").eq("email", djEmail).single();
    invitationId = data!.id;
  });

  test("the DJ verifies the invited address on a phone and names their business", async () => {
    dj = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await dj.goto(invitationLink);
    await expect(dj.getByText("Set up your DJ business on Flux DJ", { exact: true })).toBeVisible();
    await expect(dj).toHaveURL(/\/join$/); // the token left the address bar
    const requestedAt = Date.now();
    await dj.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expectLinkRequested(dj, "Check your email.", SIGN_IN_LIMIT);

    const confirm = await waitForEmail(djEmail, { after: requestedAt, subject: /Confirm your email to set up Flux DJ/ });
    await dj.goto(/(http:\/\/\S+\/auth\/confirm\?\S+)/.exec(confirm.text)![1].replace(/&amp;/g, "&"));
    await expect(dj.getByText("continue setting up your DJ business")).toBeVisible();
    await dj.getByRole("button", { name: "Sign in" }).click();
    await dj.waitForURL(`**/join/${invitationId}`);
    await expect(dj.getByText(`Your email ${djEmail} is confirmed.`)).toBeVisible();
    expect(await dj.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // The address follows the name until edited.
    await dj.getByLabel("Business name").fill("DJ Maxwell Events");
    await expect(dj.getByLabel("Web address")).toHaveValue("dj-maxwell-events");

    // A taken and a reserved address fail clearly and keep what was typed.
    await dj.getByLabel("Web address").fill(existing.slug);
    await dj.getByRole("button", { name: "Create my workspace" }).click();
    await expect(dj.getByRole("alert").filter({ hasText: "That web address is already taken. Choose another one." })).toBeVisible();
    await expect(dj.getByLabel("Business name")).toHaveValue("DJ Maxwell Events");
    await dj.getByLabel("Web address").fill("staff");
    await dj.getByRole("button", { name: "Create my workspace" }).click();
    await expect(dj.getByRole("alert").filter({ hasText: "Some words, such as “staff” or “login”, are reserved." })).toBeVisible();
    const { data: open } = await admin.from("platform_invitations").select("accepted_at").eq("id", invitationId).single();
    expect(open!.accepted_at).toBeNull();

    await dj.getByLabel("Web address").fill(slug);
    await dj.getByRole("button", { name: "Create my workspace" }).click();
    await dj.waitForURL(`**/staff/${slug}?welcome=1`);
    await expect(dj.getByText("Welcome to Flux DJ, DJ Maxwell Events", { exact: true })).toBeVisible();
    await expect(dj.getByText("Setup isn't finished")).toBeVisible();
    await expect(dj.getByRole("link", { name: "Complete them in Settings" })).toHaveAttribute("href", `/staff/${slug}/settings`);

    const { data: tenant } = await admin.from("tenants").select("id, display_name, business_name, business_address, contact_email").eq("slug", slug).single();
    createdTenantId = tenant!.id;
    expect(tenant).toMatchObject({ display_name: "DJ Maxwell Events", business_name: "DJ Maxwell Events", business_address: null, contact_email: null });
    const counts = await Promise.all(
      (["clients", "events", "gear_items", "packages", "proposal_templates", "planning_templates", "contract_templates"] as const).map(
        async (table) => (await admin.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenant!.id)).count,
      ),
    );
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("the new owner sees an unconfirmed legal name, only their own business, and a used invitation", async () => {
    await dj.goto(`/staff/${slug}/settings`);
    await expect(dj.getByLabel("Legal business name")).toHaveValue("");
    await expect(dj.getByText(/Not confirmed yet/)).toBeVisible();

    await dj.goto(`/staff/${existing.slug}`);
    await expect(dj.getByRole("heading", { name: "Page not found" })).toBeVisible();

    await dj.goto(`/join/${invitationId}`);
    await expect(dj.getByText("Your workspace is ready", { exact: true })).toBeVisible();
    await dj.getByRole("link", { name: "Open your workspace" }).click();
    await dj.waitForURL(`**/staff/${slug}?welcome=1`);

    await dj.goto(invitationLink);
    await dj.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(dj.getByText("This invitation was already used to create a workspace.")).toBeVisible();

    await operator.reload();
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: djEmail })).toContainText(`Accepted`);
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: djEmail })).toContainText(`/${slug}`);
    // Platform administration gives no access to the business (the operator has no staff role anywhere).
    await operator.goto(`/staff/${slug}`);
    await operator.waitForURL("**/login?notice=no-staff-access");
    await operator.goto("/platform/invitations");
  });

  test("a wrong account gets a switch path, and a revoked invitation stops working", async () => {
    await operator.getByLabel("DJ's email address").fill(otherEmail);
    await operator.getByRole("button", { name: "Review invitation" }).click();
    await operator.getByRole("button", { name: "Send invitation" }).click();
    await expect(operator.getByRole("status").filter({ hasText: `Invitation sent to ${otherEmail}` })).toBeVisible();
    const { data } = await admin.from("platform_invitations").select("id").eq("email", otherEmail).single();

    // The DJ from before, signed in as someone else, opens this invitation.
    await dj.goto(`/join/${data!.id}`);
    await expect(dj.getByRole("alert").filter({ hasText: `You're signed in as ${djEmail}, but this invitation was sent to e•••@example.test.` })).toBeVisible();
    await expect(dj.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(dj.getByLabel("Business name")).toHaveCount(0);

    const row = operator.getByTestId("dj-invitation").filter({ hasText: otherEmail });
    await row.getByRole("button", { name: "Revoke" }).click();
    await row.getByRole("button", { name: "Revoke invitation" }).click();
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: otherEmail })).toContainText("Revoked");
    await expect(operator.getByTestId("dj-invitation").filter({ hasText: otherEmail }).getByRole("button", { name: "Resend" })).toHaveCount(0);

    const otherDj = await (await browser.newContext()).newPage();
    await signInWithLink(otherDj, otherEmail, `/join/${data!.id}`);
    await otherDj.waitForURL(`**/join/${data!.id}`);
    await expect(otherDj.getByRole("alert").filter({ hasText: "This invitation isn't available any more." })).toBeVisible();
    await otherDj.context().close();
  });
});
