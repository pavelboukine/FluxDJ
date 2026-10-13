/**
 * Planning setup after a booking with no default planning template, in a
 * dedicated test tenant. The booking (proposal, approval, contract, signature,
 * deposit) runs through the same database functions the app calls; planning
 * goes through the UI:
 *   - booking creates Event basics only; staff are told to set planning up
 *     (not to review it), and without templates the setup offers to add them;
 *   - until then the client sees that planning is being set up, with nothing
 *     to edit, and the database refuses their saves;
 *   - staff add the starter templates and apply one from the setup card;
 *     Event basics answers are kept;
 *   - the client sees the stages, fills a section, and staff see the answer;
 *     staff can close and reopen client editing.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-psetup-${run}@example.test`;
const title = `E2E Setup Wedding ${run}`;

const basicsRow = async (eventId: string) => {
  const { data } = await admin.from("event_plans").select("id, event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === "basics")!;
  return (await admin.from("event_plan_responses").select("answers, revision, updated_by_actor").eq("item_id", item.id).maybeSingle()).data;
};

test.describe.serial("planning setup after booking", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let planningUrl = "";
  let staffPlanningUrl = "";
  let contractual = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("psetup", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Riley Chen", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-08-28",
      venue_name: "Salle E2E", venue_address: "2 Rue du Parc, Gatineau",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    // Sign in first: Auth refuses a sign-in email within a second of the setup's own magic-link token for the same address.
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    await bookEvent(tenant, eventId, clientEmail);
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("booked with Event basics only: staff are asked to set planning up, and without templates can add them", async () => {
    const plan = (await admin.from("event_plans").select("origin, initialized_via").eq("event_id", eventId).single()).data;
    expect(plan).toEqual({ origin: "fallback", initialized_via: "booking" });

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const next = staff.getByTestId("next-action");
    await expect(next).toHaveAttribute("data-key", "set_up_planning");
    await expect(next.getByTestId("next-action-primary")).toHaveAttribute("href", staffPlanningUrl);
    await expect(staff.getByTestId("overview-planning")).toContainText("Not set up");
    const card = staff.locator("#planning");
    await expect(card).toContainText("Not set up: booked with Event basics only.");
    await expect(card.getByRole("link", { name: "Edit planning" })).toHaveCount(0);
    await card.getByRole("link", { name: "Set up planning" }).click();
    await staff.waitForURL(`**${staffPlanningUrl}`);

    const setup = staff.getByTestId("planning-setup");
    await expect(setup.getByRole("heading", { name: "Set up planning" })).toBeVisible();
    await expect(staff.getByTestId("planning-setup-empty")).toContainText("No planning templates are available yet.");
    await expect(setup.getByRole("link", { name: "Add or manage planning templates" })).toHaveAttribute("href", `/staff/${tenant.slug}/planning-templates`);
    // Nothing points at a selector that isn't there, and editing isn't presented as open.
    await expect(staff.getByText("Choose a template below")).toHaveCount(0);
    await expect(staff.getByTestId("client-editing-control")).toHaveCount(0);
    await expect(staff.getByTestId("client-access")).toContainText("the client sees that you're setting it up and can't edit it");
  });

  test("the client sees that planning is being set up, can't edit, and the database refuses saves", async () => {
    const clientDb = await sessionFor(clientEmail);
    const { data: refused } = await must(clientDb.rpc("client_save_plan_basics", { p_event_id: eventId, p_tenant_slug: tenant.slug, p_expected_revision: 0, p_answers: { guest_count: 80 } }));
    expect(refused).toEqual({ status: "unavailable" });
    expect(await basicsRow(eventId)).toBeNull();

    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    await client.waitForURL("**/my");
    await expect(client.getByRole("link", { name: `Plan your event for ${title}` })).toHaveCount(0);
    await client.goto(planningUrl);
    await expect(client.getByRole("heading", { name: "Your DJ is setting up your event planning" })).toBeVisible();
    await expect(client.getByTestId("planning-setting-up")).toContainText("Check back soon.");
    await expect(client.getByRole("textbox")).toHaveCount(0);
  });

  test("staff add the starter templates and apply one from the setup card; answers are kept", async () => {
    // A staff answer before setup survives applying the template.
    await staff.goto(`${staffPlanningUrl}?section=basics`);
    await staff.getByLabel("Guest count (needed)").fill("140");
    await expect(staff.getByText("All changes saved")).toBeVisible();

    await staff.getByTestId("planning-setup").getByRole("link", { name: "Add or manage planning templates" }).click();
    await staff.waitForURL(`**/staff/${tenant.slug}/planning-templates`);
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    await expect(staff.getByTestId("planning-template-row")).toHaveCount(2);

    await staff.goto(staffPlanningUrl);
    const setup = staff.getByTestId("planning-setup");
    await setup.getByLabel("Template").selectOption({ label: "Wedding" });
    await setup.getByRole("button", { name: "Apply template" }).click();
    await expect(staff.getByText(/Template applied: 1 kept, \d+ added, 0 hidden\. No answers were removed\./)).toBeVisible();
    await staff.reload();
    await expect(staff.getByTestId("planning-setup")).toHaveCount(0);
    await expect(staff.getByTestId("client-editing-status")).toHaveText("Client editing open");
    await openPlanSection(staff, null);
    await expect(staff.getByTestId("plan-attention").getByRole("link", { name: /Ceremony/ })).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 140 });
    expect((await admin.from("event_plans").select("origin").eq("event_id", eventId).single()).data!.origin).toBe("template");

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "review_planning");
    await expect(staff.locator("#planning").getByRole("link", { name: "Edit planning" })).toBeVisible();
  });

  test("the client plans the configured event and staff see the answers; staff close and reopen editing", async () => {
    await client.goto("/my");
    await client.getByRole("link", { name: `Plan your event for ${title}` }).click();
    await client.waitForURL(`**${planningUrl}*`);
    await expect(client.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(client.getByTestId("editing-chip")).toHaveText("Planning open");
    const basics = await openPlanSection(client, "basics");
    await expect(basics.getByLabel("Guest count (needed)")).toHaveValue("140");
    await basics.getByLabel("Start time (needed)").fill("17:00");
    await expect(basics.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await basicsRow(eventId))?.updated_by_actor).toBe("client");

    await staff.goto(`${staffPlanningUrl}?section=basics`);
    await expect(staff.getByText("Last saved by the client.")).toBeVisible();
    await expect(staff.getByLabel("Start time (needed)")).toHaveValue("17:00");

    // Close, then open again, from the editing control.
    await openPlanSection(staff, null);
    const control = staff.getByTestId("client-editing-control");
    await control.getByRole("button", { name: "Close client editing…" }).click();
    await control.getByRole("dialog", { name: "Close client editing" }).getByRole("button", { name: "Close client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing closed");
    await control.getByRole("button", { name: "Open client editing…" }).click();
    await control.getByRole("dialog", { name: "Open client editing" }).getByRole("button", { name: "Open client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing open");

    // Nothing contractual changed.
    expect(await contractualState(eventId)).toBe(contractual);
  });
});
