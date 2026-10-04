/**
 * Step 6 end to end in real browsers, against local Supabase and Mailpit:
 * staff send -> client opens (signed out) -> edits -> submits -> staff approve,
 * then revision, expiry, invalid/cross-tenant links and mobile layout.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { admin, signInStaff, status, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

// A dedicated test tenant and a second one for cross-tenant checks; never the seeded BOUPROD.
let tenant: TestTenant;
let otherTenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `client-${run}@example.test`;
const eventTitle = `E2E Flow Wedding ${run}`;

const proposalLink = (text: string) => new RegExp(`(http://127\\.0\\.0\\.1:3000/${tenant.slug}/p#[A-Za-z0-9_-]{43})`).exec(text)?.[1];

test.describe.serial("send, open, edit, submit, approve", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let proposalUrl = "";
  let firstLink = "";
  let clientProposalUrl = "";
  let sentAt = 0;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("proposal", { catalog: true });
    otherTenant = await createTestTenant("proposal-other");
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Robin & Kai", email: clientEmail });
    await admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: eventTitle, event_type: "wedding", event_date: "2027-10-09",
      venue_name: "E2E Hall", internal_notes: `E2E internal note ${run}`,
    });
    await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(otherTenant);
  });

  test("staff must save before sending, then confirm recipient, event and expiry", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
    await staff.getByRole("button", { name: "Start proposal draft" }).click();
    await staff.waitForURL("**/proposals/**");
    proposalUrl = staff.url();

    await staff.getByLabel("Offer valid for (days after sending)").fill("10");
    await expect(staff.getByText("Save your changes before sending.")).toBeVisible();
    await expect(staff.getByRole("button", { name: "Review and send…" })).toBeDisabled();

    await staff.getByRole("button", { name: "Save draft" }).click();
    await expect(staff.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    await staff.getByRole("button", { name: "Review and send…" }).click();
    const dialog = staff.getByRole("dialog", { name: "Confirm sending" });
    await expect(dialog).toContainText(clientEmail);
    await expect(dialog).toContainText(eventTitle);
    await expect(dialog).toContainText("10 days after sending");
    await expect(dialog).toContainText("does not confirm a booking");
    sentAt = Date.now();
    await dialog.getByRole("button", { name: "Send proposal now" }).click();
    await expect(staff.getByText("Sent", { exact: true })).toBeVisible();
    await expect(staff.getByText(/Event status: lead \(not booked\)/)).toBeVisible();

    const { data: proposals } = await admin.from("proposals").select("status, offer_snapshot").eq("event_id", eventId);
    expect(proposals).toHaveLength(1);
    expect(proposals![0].status).toBe("sent");
  });

  test("the client gets a private link that opens signed out on a clean URL", async () => {
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    firstLink = proposalLink(email.text)!;
    expect(firstLink).toBeTruthy();
    expect(new URL(firstLink).search).toBe(""); // the token is only in the fragment

    clientContext = await browser.newContext();
    client = await clientContext.newPage();
    await client.goto(firstLink);
    await client.waitForURL(new RegExp(`/${tenant.slug}/proposals/[0-9a-f-]{36}$`));
    clientProposalUrl = client.url();
    expect(clientProposalUrl).not.toContain("#");
    await expect(client.getByRole("heading", { name: eventTitle })).toBeVisible();
    await expect(client.getByText(tenant.displayName, { exact: true }).first()).toBeVisible();
    // The DJ's recommended selections are preselected.
    await expect(client.getByRole("button", { name: /^Signature Most popular/ })).toHaveAttribute("aria-pressed", "true");
    await expect(client.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("1");
    await expect(client.locator("body")).not.toContainText(`E2E internal note ${run}`);

    const notice = await waitForEmail(tenant.ownerEmail, { after: sentAt, subject: /Proposal link opened/ });
    expect(notice.text).toContain("does not prove the client has read the proposal");
  });

  test("required gear is explained and cannot go below its minimum", async () => {
    await client.getByRole("group", { name: /ceremony take place/ }).getByLabel("A separate space").check();
    await client.getByRole("group", { name: /cocktail hour/ }).getByLabel("A separate space").check();
    await client.getByRole("group", { name: /speeches/i }).getByLabel("No").check();
    await expect(client.getByRole("heading", { name: "Required for your event" })).toBeVisible();
    await expect(client.getByText("DEMO: Your ceremony is in a separate space, so it needs its own speaker.").first()).toBeVisible();
    const speaker = client.getByRole("group", { name: "Additional-location speaker quantity" });
    await expect(speaker).toContainText("1");
    await expect(speaker.getByRole("button", { name: /^Fewer/ })).toBeDisabled();
    await expect(client.getByText("All changes saved")).toBeVisible();
  });

  test("edits made while a save is pending survive, and save failures are shown with a retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    await client.route(clientProposalUrl, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"] || held) return route.continue();
      held = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await client.getByRole("button", { name: "More Uplights (pack of 4)" }).click();
    await expect(client.getByText("Saving…")).toBeVisible();
    const notes = client.getByRole("textbox", { name: /venue/i });
    await notes.fill("Loading dock behind the kitchen");
    release();
    await expect(client.getByText("All changes saved")).toBeVisible();
    await client.unroute(clientProposalUrl);
    await expect(notes).toHaveValue("Loading dock behind the kitchen");

    await client.reload();
    await expect(client.getByRole("textbox", { name: /venue/i })).toHaveValue("Loading dock behind the kitchen");
    await expect(client.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("2");

    // A failed save keeps the input and offers a retry.
    await client.route(clientProposalUrl, (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.continue(),
    );
    await client.getByRole("button", { name: "More Uplights (pack of 4)" }).click();
    await expect(client.getByText(/Couldn't save your changes/)).toBeVisible();
    await expect(client.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("3");
    await client.unroute(clientProposalUrl);
    await client.getByRole("button", { name: "Retry saving" }).click();
    await expect(client.getByText("All changes saved")).toBeVisible();
  });

  test("catalog edits after sending do not change the client's terms", async () => {
    const { data: gear } = await admin.from("gear_items").select("id, default_price_cents").eq("tenant_id", tenant.id).eq("key", "uplights_4").single();
    await admin.from("gear_items").update({ default_price_cents: 99_900 }).eq("id", gear!.id);
    try {
      await client.reload();
      await expect(client.getByText("$120.00 per pack")).toBeVisible();
      await expect(client.getByText("$999.00")).toHaveCount(0);
    } finally {
      await admin.from("gear_items").update({ default_price_cents: gear!.default_price_cents }).eq("id", gear!.id);
    }
  });

  test("the layout fits a phone screen", async () => {
    const phone = await clientContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(clientProposalUrl);
    await expect(phone.getByRole("heading", { name: "Your total" })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("a double-clicked submit creates exactly one submission and never says booked", async () => {
    const before = Date.now();
    await client.getByRole("button", { name: `Submit for ${tenant.displayName} to review` }).dblclick();
    await expect(client.getByText("Submitted for DJ review.")).toBeVisible();
    await expect(client.locator("body")).not.toContainText(/booking (is )?confirmed|you're booked|booked!/i);
    const { data: proposal } = await admin.from("proposals").select("id, status").eq("event_id", eventId).eq("status", "submitted").single();
    const { count } = await admin.from("proposal_selections").select("id", { count: "exact", head: true }).eq("proposal_id", proposal!.id);
    expect(count).toBe(1);
    const { data: event } = await admin.from("events").select("lifecycle_status").eq("id", eventId).single();
    expect(event!.lifecycle_status).toBe("pending_approval");
    await waitForEmail(tenant.ownerEmail, { after: before, subject: /Submitted for your review/ });
  });

  test("staff review the exact submission and approve it; the client is told the contract follows", async () => {
    const before = Date.now();
    await staff.goto(proposalUrl);
    await expect(staff.getByText("Submitted for review", { exact: true })).toBeVisible();
    const summary = staff.locator("section", { has: staff.getByRole("heading", { name: "Answers" }) });
    await expect(summary).toContainText("A separate space");
    await expect(summary).toContainText("Loading dock behind the kitchen");
    await expect(staff.getByText("2 × Additional-location speaker required")).toBeVisible();
    await staff.getByRole("button", { name: "Approve…" }).click();
    await staff.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await expect(staff.getByText(/Next: generate the contract draft\. The event is not booked\./)).toBeVisible();
    await expect(staff.getByText(/Event status: awaiting signature \(not booked\)/)).toBeVisible();

    const ack = await waitForEmail(clientEmail, { after: before, subject: /approved your selection/ });
    expect(ack.text).toContain("Your contract will follow");
    await client.reload();
    await expect(client.getByText(`Approved by ${tenant.displayName}.`)).toBeVisible();
    await expect(client.getByText(/Your contract will follow/)).toBeVisible();
  });

  test("a proposal link grants no staff, event or direct database access", async () => {
    await client.goto(`/staff/${tenant.slug}`);
    await expect(client).toHaveURL(/\/login$/);
    const { count } = await admin.from("event_access").select("id", { count: "exact", head: true }).eq("event_id", eventId);
    expect(count).toBe(0);
    const anon = await fetch(`${status.API_URL}/rest/v1/proposals?select=*`, { headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${status.ANON_KEY}` } });
    expect(anon.status).toBe(401);
    await client.goto(clientProposalUrl);
  });

  test("a revised offer supersedes the old link and session", async () => {
    await staff.getByRole("button", { name: "Start a revised offer" }).click();
    await staff.waitForURL((url) => url.toString() !== proposalUrl);
    const before = Date.now();
    await staff.getByRole("button", { name: "Review and send…" }).click();
    await expect(staff.getByRole("dialog", { name: "Confirm sending" })).toContainText("replaces the offer the client has now");
    await staff.getByRole("button", { name: "Send proposal now" }).click();
    await expect(staff.getByText("Sent", { exact: true })).toBeVisible();

    await client.reload();
    await expect(client.getByRole("heading", { name: "A newer proposal is available" })).toBeVisible();
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto(firstLink);
    await expect(page.getByText("A newer version of this proposal has been sent.")).toBeVisible();

    const email = await waitForEmail(clientEmail, { after: before, subject: /sent you a proposal/ });
    const secondLink = proposalLink(email.text)!;
    expect(secondLink).not.toBe(firstLink);
    await page.goto(secondLink);
    await page.waitForURL(new RegExp(`/${tenant.slug}/proposals/`));
    clientProposalUrl = page.url();
    await client.close();
    client = page;
    clientContext = fresh;
  });

  test("invalid and cross-tenant links show a generic message", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/${tenant.slug}/p#${"A".repeat(43)}`);
    await expect(page.getByText("This proposal link is not valid or has expired.")).toBeVisible();
    await page.goto(`/${otherTenant.slug}/proposals/${clientProposalUrl.split("/").pop()}`);
    await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
    await context.close();
  });

  test("expiry while the page is open blocks submission", async () => {
    await client.getByRole("group", { name: /ceremony take place/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /cocktail hour/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /speeches/i }).getByLabel("Yes").check();
    await expect(client.getByText("All changes saved")).toBeVisible();
    const proposalId = clientProposalUrl.split("/").pop()!;
    await admin.from("proposals").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", proposalId);
    await client.getByRole("button", { name: `Submit for ${tenant.displayName} to review` }).click();
    await expect(client.getByText(/This proposal has expired/)).toBeVisible();
    const { count } = await admin.from("proposal_selections").select("id", { count: "exact", head: true }).eq("proposal_id", proposalId);
    expect(count).toBe(0);
  });
});
