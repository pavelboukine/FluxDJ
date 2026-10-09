/**
 * The DJ run sheet in a real browser against local Supabase, inside a
 * dedicated test tenant with a booked wedding (booking through the database
 * functions the app calls; see booking.ts) and answers saved through the
 * staff planning functions. On a phone:
 *   - staff reach the run sheet from the event page; it is read-only, fits
 *     the screen, keeps long playlists collapsed and Do not play one tap away;
 *   - the downloaded PDF (through the app) has the same content, private
 *     no-store headers and the page's revision; its pages are rendered for
 *     review;
 *   - a staff change after the client deadline shows on refresh and in a new
 *     export with a different revision;
 *   - signed-out visitors, the event's client and another business get no
 *     PDF and no page; nothing contractual changes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bookEvent, contractualState, must, sessionFor } from "./booking";
import { admin, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { pdfPageTexts, rasterizePdf } from "../support/pdf";

let tenant: TestTenant;
let otherTenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-runsheet-${run}@example.test`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
function sql(text: string) {
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))![1];
  execFileSync("docker", ["exec", "-i", `supabase_db_${project}`, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: text });
}
const song = (title: string, artist: string, extra: Record<string, string> = {}) => ({ id: randomUUID(), title, artist, ...extra });

test.describe.serial("DJ run sheet", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let eventId = "";
  let contractual = "";
  let runSheetUrl = "";
  let pdfUrl = "";
  let firstRevision = "";
  let saveItem: (key: string, answers: Record<string, unknown>) => Promise<void>;

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("runsheet", { catalog: true });
    otherTenant = await createTestTenant("runsheet-b");
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Chloé Gagnon", email: clientEmail, phone: "819 555-0101" }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title: `Mariage Gagnon–Lévesque ${run}`, event_type: "wedding", event_date: "2027-08-14",
      venue_name: "Château E2E", venue_address: "1 rue du Lac, Gatineau", internal_notes: "E2E INTERNAL NOTE never on the run sheet",
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
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const items = new Map(plan!.event_plan_items.map((i: { id: string; key: string }) => [i.key, i.id]));
    saveItem = async (key, answers) => {
      const { data: r } = await admin.from("event_plan_responses").select("revision").eq("item_id", items.get(key)!).maybeSingle();
      const { data } = await must(staffDb.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: items.get(key)!, p_expected_revision: r?.revision ?? 0, p_answers: answers }));
      expect((data as { status: string }).status).toBe("saved");
    };
    const parents = song("September", "Earth, Wind & Fire", { cue: "Parents" });
    const couple = song("Crazy in Love", "Beyoncé", { cue: "Couple", version: "Clean" });
    await saveItem("basics", { guest_count: 150, start_time: "15:30", end_time: "01:00", access_notes: "Loading dock at the back, door 4.\nService elevator to level 2.", announcement_language: "bilingual" });
    await saveItem("ceremony", { location_source: "other", location_other: "Chapelle Sainte-Anne", start_time: "16:00", microphones: "needed", instructions: "No music during the vows." });
    await saveItem("entrance_music", { songs: [parents, couple] });
    await saveItem("introductions", { entries: [
      { id: randomUUID(), names: "Parents de la mariée", song_id: parents.id },
      { id: randomUUID(), names: "Parents du marié", pronunciation: "lay-VESK", song_id: parents.id },
      { id: randomUUID(), names: "Chloé Gagnon et François Lévesque", pronunciation: "klo-AY gah-NYON", wording: "Pour la première fois, M. et Mme Lévesque-Gagnon!", song_id: couple.id },
    ] });
    await saveItem("speeches", { entries: [{ id: randomUUID(), speaker: "Olivier Lévesque", pronunciation: "oh-lee-VYAY", role: "Best man", timing: "cue", cue: "After the main course" }] });
    await saveItem("must_play", { songs: Array.from({ length: 80 }, (_, i) => song(`Chanson ${i + 1}`, `Artiste ${i + 1}`)) });
    await saveItem("do_not_play", { songs: [song("Macarena", "Los del Río"), song("Chicken Dance", "Werner Thomas")] });
    contractual = await contractualState(eventId);
    runSheetUrl = `/staff/${tenant.slug}/events/${eventId}/run-sheet`;
    pdfUrl = `${runSheetUrl}/pdf`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(otherTenant);
  });

  test("staff open the read-only run sheet from the event page on a phone", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.locator("#planning").getByRole("link", { name: "Open run sheet" }).click();
    await expect(staff).toHaveURL(new RegExp(`${runSheetUrl}$`));
    await expect(staff.getByRole("heading", { level: 1 })).toContainText(`Mariage Gagnon–Lévesque ${run}`);
    await expect(staff.getByTestId("run-sheet-as-of")).toContainText(/Latest saved plan as of .* · Revision [0-9A-F]{8}/);
    firstRevision = /Revision ([0-9A-F]{8})/.exec((await staff.getByTestId("run-sheet-as-of").textContent())!)![1];
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
    // Read-only: no inputs at all; links back to planning instead.
    await expect(staff.locator("main input, main textarea, main select")).toHaveCount(0);
    await expect(staff.getByRole("link", { name: "Edit planning" })).toBeVisible();
    // Each stage links to its own section in planning.
    await expect(staff.getByTestId("run-stage-ceremony").getByRole("link", { name: /Edit in planning/ }))
      .toHaveAttribute("href", `/staff/${tenant.slug}/events/${eventId}/planning?section=ceremony`);

    const entrance = staff.getByTestId("run-stage-reception_entrance");
    await expect(entrance).toContainText("Parents du marié [lay-VESK]");
    await expect(entrance).toContainText("Chloé Gagnon et François Lévesque [klo-AY gah-NYON]");
    await expect(entrance).toContainText("Announce: “Pour la première fois, M. et Mme Lévesque-Gagnon!”");
    await expect(entrance.getByText("September", { exact: true })).toHaveCount(1); // shared by both parents' entries, shown once
    await expect(staff.getByTestId("run-stage-dinner")).toContainText("Cue: After the main course");
    await expect(staff.getByTestId("run-stage-ceremony")).toContainText("No music during the vows.");

    // Long lists stay collapsed; Do not play is one tap away and open.
    await expect(staff.getByTestId("run-list-must_play")).not.toHaveAttribute("open", "");
    await expect(staff.getByTestId("run-list-must_play").getByText("Chanson 80")).toBeHidden();
    await staff.getByRole("link", { name: "Do not play (2)" }).click();
    await expect(staff.getByTestId("run-list-do_not_play").getByText("Macarena")).toBeInViewport();
    await staff.getByTestId("run-list-must_play").locator("summary").click();
    await expect(staff.getByTestId("run-list-must_play").getByText("Chanson 80")).toBeVisible();
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
    await expect(staff.locator("main")).not.toContainText("E2E INTERNAL NOTE");
    await expect(staff.locator("main")).not.toContainText("E2E-PAYMENT-REF");
    // For visual review of the phone layout (kept with the PDF samples), only when screenshots are asked for.
    if (process.env.E2E_SCREENSHOTS) await staff.screenshot({ path: "review-samples/run-sheet/live-phone.png", fullPage: true });
  });

  test("the PDF downloaded through the app matches, with private headers and the same revision", async () => {
    const download = staff.waitForEvent("download");
    await staff.getByRole("link", { name: "Download run sheet PDF" }).click();
    const file = await (await download).path();
    const bytes = readFileSync(file!);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await download).suggestedFilename()).toBe(`run-sheet-mariage-gagnon-levesque-${run}-2027-08-14.pdf`);
    const pages = await pdfPageTexts(bytes);
    if (process.env.E2E_SCREENSHOTS) {
      await rasterizePdf(bytes, "review-samples/run-sheet/app-download");
      writeFileSync("review-samples/run-sheet/app-download.pdf", bytes);
    }
    const text = pages.join("\n");
    expect(pages[0]).toContain(`Revision ${firstRevision}`);
    for (const expected of ["Gig overview", "Chloé Gagnon et François Lévesque [klo-AY gah-NYON]", "Cue: After the main course", "Loading dock at the back, door 4.", "DO NOT PLAY", "Chanson 80", "01:00 (next day, Sun, Aug 15)"]) {
      expect(text).toContain(expected);
    }
    for (const bad of ["E2E INTERNAL NOTE", "E2E-PAYMENT-REF", "undefined", "null", "[object", tenant.ownerEmail, clientEmail]) expect(text).not.toContain(bad);
    expect(text).not.toMatch(UUID);

    const response = await staff.request.get(pdfUrl);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cache-control"]).toContain("private");
    expect(response.headers()["x-run-sheet-revision"]).toBe(firstRevision);
  });

  test("a staff change after the client deadline appears on refresh and in a new export", async () => {
    sql(`select private.set_plan_cutoff_columns('${eventId}', clock_timestamp() - interval '1 day', null);`);
    await saveItem("basics", { guest_count: 165, start_time: "15:30", end_time: "01:00", access_notes: "Loading dock at the back, door 6.", announcement_language: "bilingual" });
    await staff.getByRole("link", { name: "Refresh" }).click();
    await expect(staff.getByText("Loading dock at the back, door 6.")).toBeVisible();
    await expect(staff.locator("main")).toContainText("Client editing closed since");
    await expect(staff.locator("main")).not.toContainText(/final (plan|version|run sheet)|frozen plan|plan is frozen/i);
    const revision = /Revision ([0-9A-F]{8})/.exec((await staff.getByTestId("run-sheet-as-of").textContent())!)![1];
    expect(revision).not.toBe(firstRevision);
    const response = await staff.request.get(pdfUrl);
    expect(response.headers()["x-run-sheet-revision"]).toBe(revision);
    expect((await pdfPageTexts(await response.body())).join(" ")).toContain("door 6.");
  });

  test("signed-out visitors, the client and another business get nothing", async ({ browser }) => {
    const anon = await browser.newContext();
    const anonResponse = await anon.request.get(pdfUrl, { maxRedirects: 0 });
    expect([302, 303, 307, 404]).toContain(anonResponse.status());
    expect(anonResponse.headers()["content-type"] ?? "").not.toContain("pdf");
    await anon.close();

    const clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const clientPage = await clientContext.newPage();
    await signInWithLink(clientPage, clientEmail);
    const clientResponse = await clientContext.request.get(pdfUrl, { maxRedirects: 0 });
    expect(clientResponse.headers()["content-type"] ?? "").not.toContain("pdf");
    expect([302, 303, 307, 404]).toContain(clientResponse.status());
    const clientView = await clientPage.goto(runSheetUrl);
    expect(clientPage.url().includes("/run-sheet") ? clientView!.status() : 404).toBe(404);
    await clientContext.close();

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signInStaff(otherPage, otherTenant.ownerEmail);
    const otherResponse = await otherContext.request.get(pdfUrl);
    expect(otherResponse.status()).toBe(404);
    expect(otherResponse.headers()["cache-control"]).toContain("no-store");
    const crossTenant = await otherContext.request.get(`/staff/${otherTenant.slug}/events/${eventId}/run-sheet/pdf`);
    expect(crossTenant.status()).toBe(404);
    expect((await otherPage.goto(runSheetUrl))!.status()).toBe(404);
    await otherContext.close();

    expect(await contractualState(eventId)).toBe(contractual);
  });
});
