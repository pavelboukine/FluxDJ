/**
 * Planning cutoff and staff reopening in a real browser against local
 * Supabase, inside a dedicated test tenant with a booked wedding (booking set
 * up through the database functions the app calls; see booking.ts). On phone
 * screens:
 *   - the owner sets the business's days; the existing plan keeps its own;
 *   - the client sees when editing closes, in the event's time zone;
 *   - a client tab left open across the deadline gets a clear locked
 *     response: nothing is saved, the typed value stays on screen, and every
 *     editor turns read-only at once; after reload, all saved answers read;
 *   - staff still edit, reopen with a reason and an expiry, the client edits
 *     during the reopening, staff close it early and a stale client tab is
 *     refused again;
 *   - a moved event date shows the deadline no longer matches; staff
 *     recalculate it explicitly;
 *   - no reasons, staff identities or internal notes reach the client;
 *     nothing contractual changes; no sideways scrolling.
 * The deadline is moved with trusted SQL as time passing would, never waited for.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-cutoff-${run}@example.test`;
const REASON = `Guest count changed late ${run}`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Trusted SQL on the local database (moving this test event's stored deadline). */
function sql(text: string) {
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))![1];
  execFileSync("docker", ["exec", "-i", `supabase_db_${project}`, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: text });
}

async function basicsAnswers(eventId: string) {
  const { data } = await admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i: { key: string }) => i.key === "basics")!;
  return (await admin.from("event_plan_responses").select("answers, revision").eq("item_id", item.id).maybeSingle()).data;
}

test.describe.serial("planning cutoff and reopening", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractual = "";
  let planningUrl = "";
  let staffPlanningUrl = "";

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("cutoff", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `E2E Cutoff Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14", venue_name: "Château E2E",
      internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "wedding").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    await bookEvent(tenant, eventId, clientEmail);
    contractual = await contractualState(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the owner sets the business's days; the existing plan keeps its deadline", async () => {
    await staff.goto(`/staff/${tenant.slug}/settings#planning`);
    const field = staff.getByLabel("Days before the event");
    await expect(field).toHaveValue("14");
    await field.fill("400");
    await staff.getByRole("button", { name: "Save planning deadline" }).click();
    await expect(field).toHaveJSProperty("validity.valid", false);
    await field.fill("21");
    await staff.getByRole("button", { name: "Save planning deadline" }).click();
    await expect(staff.getByText("Planning deadline saved. It applies to plans set up from now on; existing plans keep their deadlines.")).toBeVisible();
    expect((await must(admin.from("tenants").select("planning_lock_days").eq("id", tenant.id).single())).data!.planning_lock_days).toBe(21);
    const { data: plan } = await must(admin.from("event_plans").select("client_cutoff_days").eq("event_id", eventId).single());
    expect(plan!.client_cutoff_days).toBe(14);
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });

  test("the client sees when editing closes, in the event's time zone, and saves", async () => {
    await client.goto(planningUrl);
    const notice = client.getByTestId("editing-notice");
    await expect(notice).toHaveAttribute("data-state", "open");
    // 2027-08-14 minus 14 days, at 00:00 in Toronto.
    await expect(notice).toContainText("You can make changes until Saturday, July 31, 2027");
    await expect(notice).toContainText(/12:00\sa\.m\. EDT \(America\/Toronto\)/);
    await client.getByLabel("Guest count (needed)").fill("150");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 150 });
    await expect(client.getByTestId("section-basics").getByText("All changes saved")).toBeVisible();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("a tab left open across the deadline: locked response, typed value kept, every editor read-only", async () => {
    sql(`select private.set_plan_cutoff_columns('${eventId}', clock_timestamp() - interval '1 minute', null);`);
    await client.getByLabel("Guest count (needed)").fill("175");
    await expect(client.getByTestId("section-basics").getByRole("alert")).toContainText("Not saved: planning is now read-only");
    await expect(client.getByTestId("editing-notice")).toHaveAttribute("data-state", "closed");
    await expect(client.getByTestId("editing-notice")).toContainText("Planning is read-only. Contact your DJ for changes.");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("175");
    await expect(client.getByLabel("Guest count (needed)")).toBeDisabled();
    // Another editor on the page turned read-only too (shared state).
    const ceremony = client.getByTestId("stage-ceremony");
    await ceremony.locator("summary").first().click();
    await expect(ceremony.locator("input").first()).toBeDisabled();
    expect((await basicsAnswers(eventId))!.answers).toMatchObject({ guest_count: 150 });

    await client.reload();
    await expect(client.getByTestId("editing-notice")).toContainText("Planning is read-only. Contact your DJ for changes.");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
    await expect(client.getByLabel("Guest count (needed)")).toBeDisabled();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("staff still edit, see the read-only status and reopen with a reason and an expiry", async () => {
    await staff.goto(staffPlanningUrl);
    const card = staff.getByTestId("client-editing");
    await expect(card.getByTestId("client-editing-state")).toHaveText("Read-only");
    await expect(staff.getByTestId("already-open")).toHaveCount(0);
    await staff.getByLabel("Guest count (needed)").fill("160");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 160 });

    await card.getByRole("button", { name: "Reopen client editing…" }).click();
    const dialog = card.getByRole("dialog", { name: "Reopen client editing" });
    await expect(dialog).toContainText("at most 14 days from now");
    await dialog.getByRole("button", { name: "Reopen client editing", exact: true }).click();
    await expect(dialog.getByLabel("Reason")).toHaveJSProperty("validity.valid", false);
    await dialog.getByLabel("Reason").fill(REASON);
    await dialog.getByRole("button", { name: "Reopen client editing", exact: true }).click();
    await expect(dialog.getByText(/Client editing reopened until .* The normal deadline is unchanged\./)).toBeVisible();
    await expect(card.getByTestId("client-editing-state")).toHaveText("Reopened");
    await card.locator("summary", { hasText: "History" }).click();
    await expect(card.getByTestId("client-editing-history")).toContainText(REASON);
    await expect(card.getByTestId("client-editing-history")).toContainText(tenant.ownerEmail);
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });

  test("the client edits during the reopening, with its exact end shown", async () => {
    await client.reload();
    const notice = client.getByTestId("editing-notice");
    await expect(notice).toHaveAttribute("data-state", "reopened");
    await expect(notice).toContainText("reopened planning for you. You can make changes until");
    await client.getByLabel("Guest count (needed)").fill("165");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 165 });
    await expect(client.getByTestId("section-basics").getByText("All changes saved")).toBeVisible();
    const html = await client.content();
    expect(html).not.toContain(REASON);
    expect(html).not.toContain(tenant.ownerEmail);
    expect(html).not.toContain("E2E INTERNAL NOTE");
  });

  test("staff close client editing early; the client's open tab is refused and keeps its input", async () => {
    const card = staff.getByTestId("client-editing");
    await card.getByRole("button", { name: "Close client editing now…" }).click();
    const dialog = card.getByRole("dialog", { name: "Close client editing now" });
    await dialog.getByLabel("Reason").fill("Changes received");
    await dialog.getByRole("button", { name: "Close client editing", exact: true }).click();
    await expect(dialog.getByText("Client editing closed. The client can still read the plan, and you can still edit it.")).toBeVisible();
    await expect(card.getByTestId("client-editing-state")).toHaveText("Read-only");

    await client.getByLabel("Guest count (needed)").fill("190");
    await expect(client.getByTestId("section-basics").getByRole("alert")).toContainText("Not saved: planning is now read-only");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("190");
    expect((await basicsAnswers(eventId))!.answers).toMatchObject({ guest_count: 165 });
  });

  test("a moved event date: the deadline stays, staff see the mismatch and recalculate explicitly", async () => {
    await must(admin.from("events").update({ event_date: "2027-09-04" }).eq("id", eventId));
    await staff.reload();
    const card = staff.getByTestId("client-editing");
    await expect(card.getByTestId("schedule-changed")).toContainText("no longer matches");
    await expect(card.getByTestId("schedule-changed")).toContainText("Saturday, August 21, 2027");
    await card.getByRole("button", { name: "Recalculate the deadline…" }).click();
    const dialog = card.getByRole("dialog", { name: "Recalculate the deadline" });
    await dialog.getByLabel("Reason").fill("Wedding moved three weeks");
    await dialog.getByRole("button", { name: "Recalculate the deadline", exact: true }).click();
    await expect(dialog.getByText("Check the box to confirm moving the deadline.")).toBeVisible();
    await dialog.getByLabel("Move the deadline to match the event's current date.").check();
    await dialog.getByRole("button", { name: "Recalculate the deadline", exact: true }).click();
    await expect(dialog.getByText(/Deadline recalculated: Saturday, August 21, 2027/)).toBeVisible();
    await expect(card.getByTestId("client-editing-state")).toHaveText("Open");
    await expect(card.getByTestId("schedule-changed")).toHaveCount(0);
    await expect(staff.getByTestId("already-open")).toBeVisible();

    await client.reload();
    await expect(client.getByTestId("editing-notice")).toHaveAttribute("data-state", "open");
    await expect(client.getByLabel("Guest count (needed)")).toBeEnabled();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("165");
  });

  test("the event page shows the planning status; nothing contractual changed", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("planning-card-editing")).toContainText("Client editing open until Saturday, August 21, 2027");
    expect(await contractualState(eventId)).toBe(contractual);
    const { data: emails } = await must(admin.from("email_outbox").select("event_type").eq("tenant_id", tenant.id).like("event_type", "planning%"));
    expect(emails).toHaveLength(0);
  });
});
