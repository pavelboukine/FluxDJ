/**
 * Staff and team management in real browsers, against local Supabase Auth and
 * Mailpit, in dedicated test businesses: the owner reaches Team from
 * Settings, invites (a duplicate is refused), the invitation is delivered; a
 * new person verifies on a phone and accepts; an existing account (owner of
 * another business) goes straight to acceptance and keeps its own business; a
 * wrong account, cancellation, expiry and resend; removal ends an open
 * session's access; staff see no management; 320 px and keyboard.
 *
 * Only this spec uses the /join/team request form and its per-IP
 * "staff_sign_in" limit (1 per run); every other sign-in uses signInWithLink.
 * The database rules behind each step are in pgTAP 45_staff_invitations.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, expectLinkRequested, signInStaff, signInWithLink, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const run = randomUUID().slice(0, 6);
const newEmail = `e2e-team-new-${run}@example.test`;
const staffEmail = `e2e-team-staff-${run}@example.test`;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const invitationId = async (tenant: TestTenant, email: string) =>
  (await admin.from("staff_invitations").select("id").eq("tenant_id", tenant.id).eq("email", email).order("created_at", { ascending: false }).limit(1).single()).data!.id;

test.describe.serial("staff and team management", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  let owner: Page;
  let newcomer: Page;
  const links: Record<string, string> = {};

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("team");
    other = await createTestTenant("team-other");
    const { data: staffUser } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    const { error } = await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: staffUser.user!.id, role: "staff" });
    if (error) throw error;
    owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signInStaff(owner, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("the owner reaches Team from Settings, invites once, and the email is delivered", async () => {
    await owner.goto(`/staff/${tenant.slug}/settings#access`);
    await owner.getByRole("link", { name: "Manage team" }).click();
    await owner.waitForURL(`**/staff/${tenant.slug}/team`);
    await expect(owner.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    const members = owner.getByTestId("team-member");
    await expect(members).toHaveCount(2);
    await expect(members.filter({ hasText: tenant.ownerEmail })).toContainText("(you)");
    await expect(members.filter({ hasText: tenant.ownerEmail })).toContainText("Owner · Active");
    await expect(members.filter({ hasText: tenant.ownerEmail }).getByRole("button", { name: "Remove" })).toHaveCount(0); // the owner is protected
    await expect(members.filter({ hasText: staffEmail })).toContainText("Staff · Active");

    const sentAt = Date.now();
    await owner.getByLabel("Email address").fill(` ${newEmail.toUpperCase()} `);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `Invitation sent to ${newEmail}` })).toBeVisible();
    await expect(owner.getByTestId("team-invitation").filter({ hasText: newEmail })).toContainText("Pending");

    // The same address again points to the pending invitation; nothing new is created.
    await owner.getByRole("button", { name: "Invite someone else" }).click();
    await owner.getByLabel("Email address").fill(newEmail);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "already has a pending invitation" })).toBeVisible();
    // An existing member isn't invited.
    await owner.getByLabel("Email address").fill(staffEmail);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "already has access to this business" })).toBeVisible();
    expect((await admin.from("staff_invitations").select("id").eq("tenant_id", tenant.id)).data).toHaveLength(1);

    const email = await waitForEmail(newEmail, { after: sentAt, subject: /invited to join/ });
    expect(email.subject).toBe(`You've been invited to join ${tenant.displayName} on Flux DJ`);
    expect(email.text).toContain("This invitation expires on");
    links.newcomer = /(http:\/\/\S+\/join\/team#\S+)/.exec(email.text)![1];

    await owner.reload();
    await owner.getByLabel("Email address").fill(other.ownerEmail);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `Invitation sent to ${other.ownerEmail}` })).toBeVisible();
    links.existing = /(http:\/\/\S+\/join\/team#\S+)/.exec((await waitForEmail(other.ownerEmail, { after: sentAt, subject: /invited to join/ })).text)![1];
  });

  test("a new person verifies the invited address on a phone and accepts", async () => {
    newcomer = await (await browser.newContext(PHONE)).newPage();
    await newcomer.goto(links.newcomer);
    await expect(newcomer.getByRole("heading", { name: "You're invited to join a team on Flux DJ" })).toBeVisible();
    await expect(newcomer).toHaveURL(/\/join\/team$/); // the token left the address bar
    const requestedAt = Date.now();
    await newcomer.getByRole("button", { name: "Continue" }).click();
    await expectLinkRequested(newcomer, "Check your email.", { bucket: "staff_sign_in", windowSeconds: 900 });
    const confirm = await waitForEmail(newEmail, { after: requestedAt, subject: /Confirm your email to join/ });
    await newcomer.goto(/(http:\/\/\S+\/auth\/confirm\?\S+)/.exec(confirm.text)![1].replace(/&amp;/g, "&"));
    await expect(newcomer.getByRole("heading", { name: "Join your team on Flux DJ" })).toBeVisible();
    await newcomer.getByRole("button", { name: "Sign in" }).click();
    await newcomer.waitForURL(/\/join\/team\/[0-9a-f-]{36}$/);
    await expect(newcomer.getByRole("heading", { name: `Join ${tenant.displayName} on Flux DJ` })).toBeVisible();
    await expect(newcomer.getByText(`Your email ${newEmail} is confirmed.`)).toBeVisible();
    expect(await sideways(newcomer)).toBeLessThanOrEqual(0);
    await newcomer.getByRole("button", { name: "Accept invitation" }).click();
    await expect(newcomer.getByRole("heading", { name: `You've joined ${tenant.displayName}` })).toBeVisible();
    await newcomer.getByRole("link", { name: "Open business dashboard" }).click();
    await newcomer.waitForURL(`**/staff/${tenant.slug}`);
    await expect(newcomer.getByTestId("workspace-brand")).toContainText(tenant.displayName);

    // Staff see their role and no management.
    await newcomer.goto(`/staff/${tenant.slug}/settings#access`);
    await expect(newcomer.getByTestId("access-role")).toContainText("You are a staff member");
    await expect(newcomer.getByRole("link", { name: "Manage team" })).toHaveCount(0);
    await newcomer.goto(`/staff/${tenant.slug}/team`);
    await expect(newcomer.getByTestId("team-own-role")).toContainText("staff member");
    await expect(newcomer.getByRole("button", { name: "Send invitation" })).toHaveCount(0);
    await expect(newcomer.getByTestId("team-members")).toHaveCount(0);
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(users.users.filter((u) => u.email === newEmail)).toHaveLength(1);
  });

  test("an existing account, signed in, goes straight to acceptance and keeps its own business", async () => {
    const page = await (await browser.newContext()).newPage();
    await signInStaff(page, other.ownerEmail);
    await page.goto(links.existing);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/join\/team\/[0-9a-f-]{36}$/); // no second email needed
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.getByRole("link", { name: "Open business dashboard" }).click();
    await page.waitForURL(`**/staff/${tenant.slug}`);
    await page.goto(`/staff/${other.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible(); // still the owner there
    await page.context().close();
  });

  test("a wrong account is told so; cancelling and expiry stop links; resend sends a new one", async () => {
    const wrongEmail = `e2e-team-wrong-${run}@example.test`;
    await owner.reload();
    await owner.getByLabel("Email address").fill(wrongEmail);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `Invitation sent to ${wrongEmail}` })).toBeVisible();
    const id = await invitationId(tenant, wrongEmail);

    const wrong = await (await browser.newContext()).newPage();
    await signInWithLink(wrong, staffEmail, `/join/team/${id}`);
    await expect(wrong.getByRole("heading", { name: "This invitation is for another email" })).toBeVisible();
    const notice = wrong.getByRole("alert").filter({ hasText: "You're signed in as" });
    await expect(notice).toContainText(`You're signed in as ${staffEmail}`);
    await expect(notice).not.toContainText(tenant.displayName);
    await expect(wrong.getByRole("button", { name: "Sign out" })).toBeVisible();

    await owner.reload();
    const row = owner.getByTestId("team-invitation").filter({ hasText: wrongEmail });
    await row.getByRole("button", { name: "Cancel invitation" }).click();
    await owner.getByRole("dialog", { name: `Cancel the invitation for ${wrongEmail}?` }).getByRole("button", { name: "Cancel invitation" }).click();
    // The row leaves the pending list (with its confirmation) once cancelled.
    await expect(owner.getByTestId("team-invitation").filter({ hasText: wrongEmail })).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByTestId("team-invitation-history")).toContainText(`${wrongEmail} · cancelled`);
    await wrong.reload();
    await expect(wrong.getByRole("heading", { name: "This invitation isn't available" })).toBeVisible();
    await wrong.context().close();

    // Expired: shown as such, and Resend sends a fresh link.
    const lateEmail = `e2e-team-late-${run}@example.test`;
    await owner.getByLabel("Email address").fill(lateEmail);
    await owner.getByRole("button", { name: "Send invitation" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `Invitation sent to ${lateEmail}` })).toBeVisible();
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin.from("staff_invitations").update({ expires_at: past, last_sent_at: past }).eq("id", await invitationId(tenant, lateEmail));
    await owner.reload();
    const late = owner.getByTestId("team-invitation").filter({ hasText: lateEmail });
    await expect(late).toHaveAttribute("data-state", "expired");
    const resentAt = Date.now();
    await late.getByRole("button", { name: "Resend" }).click();
    await owner.getByRole("dialog", { name: `Send a new invitation link to ${lateEmail}?` }).getByRole("button", { name: "Send a new link" }).click();
    await expect(owner.getByRole("status").filter({ hasText: `A new link was sent to ${lateEmail}` })).toBeVisible();
    await waitForEmail(lateEmail, { after: resentAt, subject: /invited to join/ });
    await owner.reload();
    await expect(owner.getByTestId("team-invitation").filter({ hasText: lateEmail })).toHaveAttribute("data-state", "pending");
  });

  test("removing a staff member ends their open session's access at once", async () => {
    await owner.reload();
    const row = owner.getByTestId("team-member").filter({ hasText: newEmail });
    await row.getByRole("button", { name: "Remove" }).click();
    await owner.getByRole("dialog", { name: `Remove ${newEmail} from ${tenant.displayName}?` }).getByRole("button", { name: "Remove access" }).click();
    await expect(owner.getByTestId("team-member").filter({ hasText: newEmail })).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByTestId("team-removed")).toContainText(newEmail);

    await newcomer.goto(`/staff/${tenant.slug}`);
    await newcomer.waitForURL("**/login?notice=no-staff-access");
    await newcomer.goto(`/staff/${tenant.slug}/events`);
    await newcomer.waitForURL("**/login?notice=no-staff-access");
    await newcomer.context().close();
  });

  test("on a 320 px phone: no sideways scrolling, and confirmations work from the keyboard", async () => {
    const page = await (await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    await page.goto(`/staff/${tenant.slug}/team`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const resend = page.getByTestId("team-invitation").first().getByRole("button", { name: "Resend" });
    await resend.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Send a new link" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });
});
