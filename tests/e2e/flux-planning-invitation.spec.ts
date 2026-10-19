/**
 * The planning invitation for a normal Flux booking, in a real browser
 * against local Supabase, in a dedicated test tenant. The booking itself
 * (proposal, approval, contract, signature, deposit) goes through the same
 * database functions the app calls (bookEvent); everything about the
 * invitation goes through the UI:
 *   - booking and opening client editing email nothing about planning;
 *     staff are told the invitation is a separate step, and closed editing
 *     blocks it with a way to open it;
 *   - staff send the planning invitation; its status never says sent before
 *     the email went out; the email arrives in Mailpit;
 *   - the client, already signed in from their contract, opens the link and
 *     continues without a second verification email, saves planning and sees
 *     the event on /my; another account is refused;
 *   - the controls work on a phone-sized screen without sideways scrolling.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, must, sessionFor } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-fluxinvite-${run}@example.test`;
const title = `E2E Flux Invite Wedding ${run}`;
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const planningEmails = async () =>
  (await admin.from("email_outbox").select("id").eq("recipient_email", clientEmail).eq("entity_type", "planning_invitation")).data ?? [];

test.describe.serial("planning invitation for a Flux booking", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let eventUrl = "";
  let invitationLink = "";

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("fluxinvite", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-09-18", venue_name: "Salle E2E" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
    await bookEvent(tenant, eventId, clientEmail);
    eventUrl = `/staff/${tenant.slug}/events/${eventId}`;

    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
  });

  test.afterAll(async () => {
    await staffContext?.close();
    await clientContext?.close();
    await archiveTestTenant(tenant);
  });

  test("booking emails nothing about planning; the invitation is a separate, explained step", async () => {
    expect(await planningEmails()).toEqual([]);
    await staff.goto(eventUrl);
    await expect(staff.getByTestId("event-header-status")).toHaveText(/Booked/);
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "review_planning");
    await expect(staff.getByTestId("next-action-secondary")).toHaveText("Send planning invitation");
    const access = staff.getByTestId("client-access");
    await expect(access).toContainText("Nothing is sent automatically: not when the event is created or booked");
    await expect(access.getByTestId("planning-invitation")).toHaveCount(0);
    await expect(access).toContainText(clientEmail);
    await expect(access.getByRole("button", { name: "Send planning invitation" })).toBeVisible();

    // Closing client editing blocks the invitation, with the way to open it; opening it sends nothing.
    await staff.goto(`${eventUrl}/planning`);
    await expect(staff.getByTestId("planning-invite-hint")).toContainText("hasn't been told it's ready");
    await staff.getByRole("button", { name: "Close client editing…" }).click();
    await staff.getByRole("button", { name: "Close client editing", exact: true }).click();
    await expect(staff.getByTestId("client-editing-control")).toHaveAttribute("data-state", "closed");
    await staff.goto(eventUrl);
    await expect(access.getByTestId("client-access-blocker")).toContainText("Client editing is closed.");
    await expect(access.getByRole("button", { name: "Send planning invitation" })).toHaveCount(0);
    await access.getByRole("link", { name: "Open the planning page" }).click();
    await staff.waitForURL(`**${eventUrl}/planning`);
    await staff.getByRole("button", { name: "Open client editing…" }).click();
    await staff.getByRole("button", { name: "Open client editing", exact: true }).click();
    await expect(staff.getByTestId("client-editing-control")).toHaveAttribute("data-state", "open");
    expect(await planningEmails()).toEqual([]);
  });

  test("staff send the planning invitation; the status follows the real delivery", async () => {
    await staff.goto(eventUrl);
    const access = staff.getByTestId("client-access");
    const sentAfter = Date.now();
    await access.getByRole("button", { name: "Send planning invitation" }).click();
    await expect(access.getByTestId("planning-invitation-recipient")).toHaveText(clientEmail);
    await expect(access.getByTestId("planning-invitation-status")).toHaveText(/^(Queued|Sent|Accepted)$/);

    const email = await waitForEmail(clientEmail, { after: sentAfter, subject: /^It's time to plan your event!/ });
    expect(email.text).toContain("Hi Jordan,");
    expect(email.text).toContain("Open your planning portal");
    expect(email.text).not.toMatch(/proposal|contract|deposit|payment/i);
    invitationLink = /(http\S+\/planning-invite#\S+)/.exec(email.text)![1];
    await staff.reload();
    await expect(access.getByTestId("planning-invitation-status")).toHaveText("Sent");
    await expect(staff.getByTestId("communication").filter({ hasText: "Planning invitation" })).toHaveCount(1);
  });

  test("the signed-in client continues without a second verification, plans and sees the event on /my", async () => {
    await signInWithLink(client, clientEmail);
    await client.waitForURL("**/my");
    await client.goto(invitationLink.replace(/^https?:\/\/[^/]+/, ""));
    await expect(client.getByText("You're already signed in with the email address")).toBeVisible();
    await expect(client.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
    await client.getByRole("link", { name: "Continue to my planning" }).click();
    await client.waitForURL(`**/${tenant.slug}/planning-invitations/*`);
    await client.getByRole("button", { name: "Open my planning" }).click();
    await client.waitForURL(`**/${tenant.slug}/planning/${eventId}`);
    await expect(client.getByTestId("editing-chip")).toHaveText("Planning open");
    const basics = await openPlanSection(client, "basics");
    await basics.getByLabel("Guest count (needed)").fill("135");
    await expect(basics.getByText("All changes saved")).toBeVisible();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);

    await client.goto("/my");
    await expect(client.locator("li").filter({ hasText: title }).first()).toBeVisible();
    const { count } = await must(admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId).is("revoked_at", null));
    expect(count).toBe(1);
  });

  test("staff see the answer and the acceptance; another account is refused; the controls fit a phone", async () => {
    await staff.goto(`${eventUrl}/planning?section=basics`);
    await expect(staff.getByLabel("Guest count (needed)")).toHaveValue("135");
    await staff.goto(eventUrl);
    const access = staff.getByTestId("client-access");
    await expect(access.getByTestId("planning-invitation-status")).toHaveText("Accepted");

    // Staff are signed in with another verified address: the invitation isn't theirs.
    const { data: invitation } = await must(admin.from("planning_invitations").select("id").eq("event_id", eventId).is("revoked_at", null).single());
    await staff.goto(`/${tenant.slug}/planning-invitations/${invitation!.id}`);
    await expect(staff.getByText("but this invitation was sent to")).toBeVisible();

    await staff.setViewportSize({ width: 375, height: 812 });
    await staff.goto(`${eventUrl}#client-access`);
    await expect(access.getByRole("button", { name: "Send a new planning invitation" })).toBeVisible();
    await expect(access.getByTestId("planning-invitation-recipient")).toBeVisible();
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });
});
