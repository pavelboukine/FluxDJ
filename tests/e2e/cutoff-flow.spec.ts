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
 *   - staff still edit, open editing again until a chosen time (the deadline
 *     has passed), the client edits during the reopening, staff close it and
 *     a stale client tab is refused again;
 *   - a moved event date shows the deadline no longer matches; staff
 *     recalculate it explicitly; a staff close still holds before the new
 *     deadline; opening before it needs no end; closing before it refuses
 *     the client's open tab at once while staff keep editing;
 *   - no reasons, staff identities or internal notes reach the client;
 *     nothing contractual changes; no sideways scrolling.
 * The deadline is moved with trusted SQL as time passing would, never waited for.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink } from "./support";
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
    await expect(client.getByTestId("editing-chip")).toHaveText("Planning open");
    await openPlanSection(client, "basics");
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
    await expect(client.getByTestId("editing-chip")).toHaveText("Read-only");
    // Another section's editors turned read-only too (shared state); the rejected edit is flagged, never shown as saved.
    const ceremony = await openPlanSection(client, "ceremony");
    await expect(ceremony.locator("input").first()).toBeDisabled();
    await expect(client.getByTestId("section-picker").getByTestId("nav-basics")).toContainText("Not saved");
    await expect(client.getByTestId("unsaved-elsewhere")).toContainText("Open Event basics");
    expect((await basicsAnswers(eventId))!.answers).toMatchObject({ guest_count: 150 });

    // Read-only planning stays browsable: every section opens, and the overview offers "View planning".
    await client.goto(planningUrl);
    await expect(client.getByTestId("editing-notice")).toContainText("Planning is read-only. Contact your DJ for changes.");
    await expect(client.getByTestId("plan-primary")).toHaveText("View planning");
    await client.getByTestId("plan-primary").click();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
    await expect(client.getByLabel("Guest count (needed)")).toBeDisabled();
    await openPlanSection(client, "party");
    await expect(client.locator("#plan-panel-party input").first()).toBeDisabled();
    await openPlanSection(client, "basics");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("staff still edit, see the closed status up front and open editing again for a limited time", async () => {
    await staff.goto(staffPlanningUrl);
    const control = staff.getByTestId("client-editing-control");
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing closed");
    await expect(control.getByTestId("client-editing-detail")).toContainText("The deadline passed on");
    await openPlanSection(staff, "basics");
    await staff.getByLabel("Guest count (needed)").fill("160");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 160 });

    // After the deadline, opening is temporary: it needs an end, at most 14 days away.
    await control.getByRole("button", { name: "Open client editing…" }).click();
    const dialog = control.getByRole("dialog", { name: "Open client editing" });
    await expect(dialog).toContainText("at most 14 days from now");
    await expect(dialog.getByLabel(/Client can edit until/)).toBeVisible();
    await dialog.getByLabel("Note (optional)").fill(REASON);
    await dialog.getByRole("button", { name: "Open client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing open");
    await expect(control.getByTestId("client-editing-detail")).toContainText(/Reopened by staff until .*\(America\/Toronto\)\. The normal deadline was /);
    const card = await openPlanSection(staff, "client-editing");
    await card.locator("summary", { hasText: "History" }).click();
    await expect(card.getByTestId("client-editing-history")).toContainText(REASON);
    await expect(card.getByTestId("client-editing-history")).toContainText(tenant.ownerEmail);
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });

  test("the client edits during the reopening, with its exact end shown", async () => {
    await client.reload();
    const notice = client.getByTestId("editing-notice");
    await expect(notice).toHaveAttribute("data-state", "reopened");
    await expect(notice).toContainText(/reopened planning for you\. You can make changes until .+ \(America\/Toronto\)\./);
    await expect(client.getByTestId("editing-chip")).toHaveText("Reopened");
    await client.getByLabel("Guest count (needed)").fill("165");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 165 });
    await expect(client.getByTestId("section-basics").getByText("All changes saved")).toBeVisible();
    const html = await client.content();
    expect(html).not.toContain(REASON);
    expect(html).not.toContain(tenant.ownerEmail);
    expect(html).not.toContain("E2E INTERNAL NOTE");
  });

  test("staff close client editing early; the client's open tab is refused and keeps its input", async () => {
    const control = staff.getByTestId("client-editing-control");
    await control.getByRole("button", { name: "Close client editing…" }).click();
    const dialog = control.getByRole("dialog", { name: "Close client editing" });
    await expect(dialog).toContainText("including in a page they already have open");
    await dialog.getByLabel("Note (optional)").fill("Changes received");
    await dialog.getByRole("button", { name: "Close client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing closed");
    await expect(control.getByTestId("client-editing-detail")).toContainText("Closed by staff on");

    await client.getByLabel("Guest count (needed)").fill("190");
    await expect(client.getByTestId("section-basics").getByRole("alert")).toContainText("Not saved: planning is now read-only");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("190");
    expect((await basicsAnswers(eventId))!.answers).toMatchObject({ guest_count: 165 });
  });

  test("a moved event date: staff recalculate the deadline, and a staff close still holds before it", async () => {
    await must(admin.from("events").update({ event_date: "2027-09-04" }).eq("id", eventId));
    await staff.reload();
    const control = staff.getByTestId("client-editing-control");
    const card = staff.getByTestId("client-editing");
    await expect(card.getByTestId("schedule-changed")).toContainText("no longer matches");
    await expect(card.getByTestId("schedule-changed")).toContainText("Saturday, August 21, 2027");
    await card.getByRole("button", { name: "Recalculate the deadline…" }).click();
    const recalc = card.getByRole("dialog", { name: "Recalculate the deadline" });
    await recalc.getByLabel("Reason").fill("Wedding moved three weeks");
    await recalc.getByRole("button", { name: "Recalculate the deadline", exact: true }).click();
    await expect(recalc.getByText("Check the box to confirm moving the deadline.")).toBeVisible();
    await recalc.getByLabel("Move the deadline to match the event's current date.").check();
    await recalc.getByRole("button", { name: "Recalculate the deadline", exact: true }).click();
    await expect(recalc.getByText(/Deadline recalculated: Saturday, August 21, 2027/)).toBeVisible();
    await expect(card.getByTestId("schedule-changed")).toHaveCount(0);
    // The deadline is in the future again, but the staff close wins until staff open editing.
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing closed");
    await client.reload();
    await expect(client.getByTestId("editing-notice")).toHaveAttribute("data-state", "closed");
    await expect(client.getByTestId("editing-notice")).toContainText(`${tenant.displayName} has closed planning to changes.`);
    await expect(client.getByLabel("Guest count (needed)")).toBeDisabled();

    // Before the deadline, opening needs no end: editing follows the normal deadline.
    await control.getByRole("button", { name: "Open client editing…" }).click();
    const open = control.getByRole("dialog", { name: "Open client editing" });
    await expect(open).toContainText("until the normal deadline (Saturday, August 21, 2027");
    await expect(open.getByLabel(/Client can edit until/)).toHaveCount(0);
    await open.getByRole("button", { name: "Open client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing open");
    await expect(control.getByTestId("client-editing-detail")).toContainText("Open until the normal deadline, Saturday, August 21, 2027");
    await client.reload();
    await expect(client.getByTestId("editing-notice")).toHaveAttribute("data-state", "open");
    await expect(client.getByLabel("Guest count (needed)")).toBeEnabled();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("165");

    // Closing before the deadline takes effect at once, even in the client's open tab; staff keep editing.
    await control.getByRole("button", { name: "Close client editing…" }).click();
    await control.getByRole("dialog", { name: "Close client editing" }).getByRole("button", { name: "Close client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing closed");
    await client.getByLabel("Guest count (needed)").fill("170");
    await expect(client.getByTestId("section-basics").getByRole("alert")).toContainText("Not saved: planning is now read-only");
    await expect(client.getByTestId("editing-notice")).toContainText(`${tenant.displayName} has closed planning to changes.`);
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("170");
    const basics = await openPlanSection(staff, "basics");
    await basics.getByLabel("Guest count (needed)").fill("168");
    await expect.poll(async () => (await basicsAnswers(eventId))?.answers).toMatchObject({ guest_count: 168 });

    await control.getByRole("button", { name: "Open client editing…" }).click();
    await control.getByRole("dialog", { name: "Open client editing" }).getByRole("button", { name: "Open client editing", exact: true }).click();
    await expect(control.getByTestId("client-editing-status")).toHaveText("Client editing open");
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });

  test("the event page shows the planning status; nothing contractual changed", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(staff.getByTestId("planning-card-editing")).toContainText("Client editing open until Saturday, August 21, 2027");
    expect(await contractualState(eventId)).toBe(contractual);
    const { data: emails } = await must(admin.from("email_outbox").select("event_type").eq("tenant_id", tenant.id).like("event_type", "planning%"));
    expect(emails).toHaveLength(0);
  });
  test("a Simple Party plan stays small for staff, in planning and on the run sheet", async () => {
    const partyId = randomUUID();
    await must(admin.from("events").insert({ id: partyId, tenant_id: tenant.id, title: `E2E Party ${run}`, event_type: "party", event_date: "2027-09-18", venue_name: "Loft E2E" }));
    const { data: party } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "simple_party").single());
    await must((await sessionFor(tenant.ownerEmail)).rpc("setup_event_plan", { p_event_id: partyId, p_template_id: party!.id }));
    await staff.goto(`/staff/${tenant.slug}/events/${partyId}/planning`);
    await expect(staff.getByRole("heading", { level: 1, name: `E2E Party ${run}` })).toBeVisible();
    const stages = staff.getByTestId("section-picker").getByRole("list", { name: "Stages of the event, in order", includeHidden: true }).locator(":scope > li");
    await expect(stages).toHaveText([/1\. Party/]);
    const panel = await openPlanSection(staff, "party");
    await expect(panel.getByTestId("moment-must_play")).toHaveCount(1);
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
    await staff.goto(`/staff/${tenant.slug}/events/${partyId}/run-sheet`);
    await expect(staff.locator("[data-testid^=run-stage-]")).toHaveCount(1);
    await expect(staff.getByTestId("run-stage-party")).toBeVisible();
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });
});
