/**
 * An event booked outside Flux DJ, end to end in a dedicated test tenant:
 *   - staff create it from the normal Create event form ("Already booked
 *     elsewhere", new client); it reads "Booked externally" everywhere and
 *     its next steps follow planning, never proposal, contract or deposit;
 *   - staff set planning up from a template and invite the client (the real
 *     email, from the real outbox); the client verifies their address
 *     (signInWithLink, as the "Confirm your email" link does: the request
 *     form's rate limit stays untouched), accepts and plans;
 *   - the client home says the event is booked, with no contract or payment;
 *   - staff follow the answers and open the web and PDF run sheet;
 *   - a normal Flux event (existing client) still starts with a proposal.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { must, sessionFor } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-extbook-${run}@example.test`;
const clientName = `Riya Ext ${run}`;
const title = `E2E External Wedding ${run}`;
const fluxTitle = `E2E Flux Wedding ${run}`;

test.describe.serial("event booked elsewhere", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let eventUrl = "";

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("extbook");
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    clientContext = await browser.newContext();
    client = await clientContext.newPage();
  });

  test.afterAll(async () => {
    await staffContext?.close();
    await clientContext?.close();
    await archiveTestTenant(tenant);
  });

  test("staff create an event booked elsewhere, with a new client, from the Create event form", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/new`);
    await staff.getByLabel("New client").check();
    await staff.getByLabel("Name", { exact: true }).fill(clientName);
    await staff.getByLabel("Email", { exact: true }).fill(clientEmail);
    await staff.getByTestId("booking-source").getByRole("radio", { name: /Already booked elsewhere/ }).check();
    await staff.getByLabel("Title", { exact: true }).fill(title);
    await staff.getByLabel("Date", { exact: true }).fill("2027-08-28");
    await staff.getByRole("button", { name: "Create event" }).click();
    await staff.waitForURL(/\/events\/[0-9a-f-]{36}$/);
    eventUrl = new URL(staff.url()).pathname;
    eventId = eventUrl.split("/").pop()!;

    const { data: event } = await must(admin.from("events").select("booking_source, lifecycle_status, booking_confirmed_at").eq("id", eventId).single());
    expect(event).toEqual({ booking_source: "external", lifecycle_status: "lead", booking_confirmed_at: null });

    await staff.reload();
    await expect(staff.getByTestId("event-header-status")).toHaveText("Booked externally");
    await expect(staff.getByTestId("booking-source-note")).toHaveText("Booked outside Flux DJ. Planning is managed here.");
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "set_up_planning");
    // No proposal, contract or payment workflow is offered: planning leads, then client access.
    await expect(staff.getByTestId("workspace")).toHaveAttribute("data-stage", "external");
    await expect(staff.locator("#proposal")).toHaveCount(0);
    await expect(staff.locator("#contract")).toHaveCount(0);
    await expect(staff.locator("#payments")).toHaveCount(0);
    await expect(staff.locator("#documents")).toHaveCount(0);
    await expect(staff.locator("main")).not.toContainText(/Create a proposal|Prepare the contract|Record the deposit|Waiting for the client to sign/);
    await expect(staff.getByTestId("client-access-state")).toContainText("Planning isn't open to your client yet");
    await expect(staff.getByTestId("client-access-headline")).toHaveText("Not open yet");
    await expect(staff.getByTestId("client-access-blocker")).toContainText("Set up planning before opening it to your client.");
    await expect(staff.getByTestId("client-access").getByRole("button")).toHaveCount(0);
    // The client's email is stored on the primary contact the form created.
    const { data: primary } = await must(admin.from("event_clients").select("is_primary, clients(name, email)").eq("event_id", eventId).single());
    expect(primary).toEqual({ is_primary: true, clients: { name: clientName, email: clientEmail } });
  });

  test("staff set planning up from a template, then open it and invite the client in one step; nothing is sent before", async () => {
    expect((await admin.from("email_outbox").select("id").eq("recipient_email", clientEmail)).data).toEqual([]);
    await staff.getByTestId("next-action-primary").click();
    await staff.waitForURL(`**${eventUrl}/planning`);
    await expect(staff.getByText("This event was booked outside Flux DJ.")).toBeVisible();
    await staff.getByLabel("Template").selectOption({ label: "Wedding" });
    await staff.getByRole("button", { name: "Set up planning" }).click();
    await expect(staff.getByTestId("client-access")).toContainText("Planning isn't open to the client yet");
    // Where staff prepare planning, they're told the client can't see it yet, and where to open it.
    const hint = staff.getByTestId("planning-invite-hint");
    await expect(hint).toHaveAttribute("data-state", "not_opened");
    await expect(hint).toContainText("Planning is ready, but your client can't access it yet.");
    await expect(hint.getByRole("link", { name: "Open from Client access" })).toHaveAttribute("href", `${eventUrl}#client-access`);
    expect((await admin.from("email_outbox").select("id").eq("recipient_email", clientEmail)).data).toEqual([]);

    // Planning-only events get the same dashboard reminder.
    await staff.goto(`/staff/${tenant.slug}`);
    await expect(staff.getByTestId("attention-item").filter({ hasText: title })).toHaveAttribute("data-kind", "planning_not_open");

    await staff.goto(eventUrl);
    // Preparing and opening are separate steps.
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "open_planning");
    await expect(staff.getByTestId("planning-card-not-opened")).toContainText("Planning is ready, but your client can't access it yet.");
    const sentAfter = Date.now();
    await staff.getByTestId("next-action-secondary").click();
    const access = staff.getByTestId("client-access");
    await expect(access).toContainText(clientEmail);
    await expect(access.getByTestId("open-without-emailing").getByRole("button", { name: "Open without emailing" })).toBeVisible();
    staff.once("dialog", (d) => void d.accept());
    await access.getByRole("button", { name: "Open planning & send invitation" }).click();
    await expect(access).toHaveAttribute("data-opened", "true");
    await expect(access.getByTestId("open-without-emailing")).toHaveCount(0);
    await expect(access.getByTestId("client-access-state")).toContainText(`Planning invitation for ${clientEmail}`);
    await expect(access.getByTestId("planning-invitation-recipient")).toHaveText(clientEmail);
    await expect(access.getByTestId("planning-invitation-status")).toHaveText(/^(Queued|Sent)$/);
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "awaiting_planning_acceptance");

    const email = await waitForEmail(clientEmail, { after: sentAfter, subject: /^It's time to plan your event!/ });
    expect(email.subject).toBe("It's time to plan your event!");
    expect(email.text).toContain("We're ready to start planning your event!");
    expect(email.text).toContain(title);
    await staff.reload();
    await expect(access.getByTestId("planning-invitation-status")).toHaveText("Sent");
    expect(email.text).not.toMatch(/proposal|contract|deposit|payment/i);
    const link = /(http\S+\/planning-invite#\S+)/.exec(email.text)![1];

    // The link page offers the verification email; opening it sends nothing.
    await client.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(client.getByRole("heading", { level: 1, name: "You're invited to plan your event" })).toBeVisible();
    await expect(client.locator("main")).toContainText(tenant.displayName);
    await expect(client.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    expect(new URL(client.url()).hash).toBe("");

    // Verified as the "Confirm your email" link does, back to the invitation.
    const tokenHash = createHash("sha256").update(new URL(link).hash.slice(1)).digest("hex");
    const { data: invitation } = await must(admin.from("planning_invitations").select("id").eq("token_hash", tokenHash).single());
    await signInWithLink(client, clientEmail, `/${tenant.slug}/planning-invitations/${invitation!.id}`);
    await client.waitForURL(`**/${tenant.slug}/planning-invitations/${invitation!.id}`);
    await expect(client.getByText("Let's plan the details.")).toBeVisible();
    await client.getByRole("button", { name: "Open my planning" }).click();
    await client.waitForURL(`**/${tenant.slug}/planning/${eventId}`);
    await expect(client.getByRole("heading", { level: 1, name: title })).toBeVisible();
  });

  test("the client plans and saves; their home says booked, with nothing to sign or pay", async () => {
    await expect(client.getByTestId("editing-chip")).toHaveText("Planning open");
    const basics = await openPlanSection(client, "basics");
    await basics.getByLabel("Guest count (needed)").fill("120");
    await expect(basics.getByText("All changes saved")).toBeVisible();
    await client.reload();
    await expect((await openPlanSection(client, "basics")).getByLabel("Guest count (needed)")).toHaveValue("120");

    await client.goto("/my");
    const card = client.locator("li").filter({ hasText: title }).first();
    await expect(card).toContainText("Booked");
    // The same next step as the event's hub.
    await expect(card.getByTestId("event-next-step")).toContainText("Plan your event");
    await expect(card).not.toContainText(/contract|deposit|proposal/i);
    await expect(card.getByRole("link")).toHaveText([`Open your event for ${title}`]);
  });

  test("staff follow the answers and open the web and PDF run sheet", async () => {
    await staff.goto(eventUrl);
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "monitor_planning");
    await expect(staff.getByTestId("client-access-state")).toContainText("The client has verified access and can open planning");
    await staff.goto(`${eventUrl}/planning?section=basics`);
    await expect(staff.getByLabel("Guest count (needed)")).toHaveValue("120");
    await expect(staff.getByText("Last saved by the client.")).toBeVisible();

    await staff.goto(`${eventUrl}/run-sheet`);
    await expect(staff.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(staff.locator("main")).not.toContainText(/contract|deposit/i);
    const pdf = await staff.request.get(`${eventUrl}/run-sheet/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("lists and dashboard show it as booked externally; a Flux event with an existing client still starts with a proposal", async () => {
    await staff.goto(`/staff/${tenant.slug}/events?status=external`);
    const row = staff.getByTestId("event-row").filter({ hasText: title });
    await expect(row.getByTestId("event-status")).toHaveText("Booked externally");
    await staff.goto(`/staff/${tenant.slug}`);
    await expect(staff.getByRole("link").filter({ hasText: title })).toContainText("Booked externally");

    await staff.goto(`/staff/${tenant.slug}/events/new`);
    await expect(staff.getByTestId("booking-source").getByRole("radio", { name: /Book through Flux DJ/ })).toBeChecked();
    await expect(staff.getByTestId("booking-source").getByRole("checkbox", { name: /Send a proposal first/ })).toBeChecked();
    await staff.getByLabel("Existing client").check();
    await staff.getByLabel("Client", { exact: true }).fill(clientName);
    await staff.getByRole("list", { name: "Matching clients" }).getByRole("button").filter({ hasText: clientName }).click();
    await staff.getByLabel("Title", { exact: true }).fill(fluxTitle);
    await staff.getByLabel("Date", { exact: true }).fill("2027-09-04");
    await staff.getByRole("button", { name: "Create event" }).click();
    await staff.waitForURL(/\/events\/[0-9a-f-]{36}$/);
    const fluxId = new URL(staff.url()).pathname.split("/").pop()!;
    await expect(staff.getByTestId("next-action")).toHaveAttribute("data-key", "create_proposal");
    await expect(staff.getByTestId("event-header-status")).toHaveText("New inquiry");
    await expect(staff.getByTestId("workspace")).toHaveAttribute("data-stage", "booking");
    await expect(staff.locator("#proposal").getByRole("button", { name: "Start proposal draft" })).toBeVisible();
    await expect(staff.getByTestId("client-access")).toHaveCount(0);
    const { data: flux } = await must(admin.from("events").select("booking_source").eq("id", fluxId).single());
    expect(flux!.booking_source).toBe("flux");
    const { count } = await must(admin.from("clients").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("email", clientEmail));
    expect(count).toBe(1);
  });
});
