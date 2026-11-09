/**
 * Custom planning questions, end to end: a template with the DJ's own section (every question type),
 * a custom stage with its own moment, and a custom moment in a library stage (made through the
 * database functions; custom-authoring-flow covers the authoring screens). The template editor lists the questions
 * and the template preview renders them without saving; the plan copies them; the client answers
 * with the planning inputs (incomplete answers save, required ones drive "Still needed"); staff see
 * the same answers, and after staff remove an answered question and a chosen option the answers are
 * kept and still readable; the run sheet lists them; "Preview as client" shows them without saving.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, must, openPlanning, sessionFor } from "./booking";
import { admin, openPlanMoment, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-custom-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const CULTURAL = [
  { id: "q_style", type: "single_choice", label: "Which traditions should the music include?", required: true,
    options: [{ id: "o_greek", label: "Greek" }, { id: "o_lebanese", label: "Lebanese" }, { id: "o_armenian", label: "Armenian" }] },
  { id: "q_songs", type: "songs", label: "Traditional songs", required: true, help: "Songs your families will expect to hear." },
  { id: "q_hora", type: "yes_no", label: "Will there be a hora?", required: true },
  { id: "q_langs", type: "multi_choice", label: "Languages for announcements", required: false,
    options: [{ id: "o_en", label: "English" }, { id: "o_fr", label: "French" }, { id: "o_gr", label: "Greek" }] },
  { id: "q_when", type: "time", label: "When should the cultural set start?", required: false },
  { id: "q_name", type: "short_text", label: "Family name to announce", required: false },
  { id: "q_notes", type: "long_text", label: "Anything the DJ should know?", required: false },
];
const HORA = [
  { id: "q_start", type: "time", label: "When does the hora start?", required: true },
  { id: "q_lead", type: "short_text", label: "Who leads it?", required: false },
];

/** Fills a songs question's "Add song" form and adds the song. */
async function addSong(question: Locator, song: { title: string; artist: string }) {
  const form = question.getByTestId(/-add$/);
  if (!(await form.evaluate((el) => (el as HTMLDetailsElement).open))) await form.locator("summary").click();
  await form.getByLabel("Title", { exact: true }).fill(song.title);
  await form.getByLabel("Artist", { exact: true }).fill(song.artist);
  await form.getByRole("button", { name: "Add song" }).click();
}

async function answersOf(itemId: string) {
  return (await admin.from("event_plan_responses").select("answers, revision").eq("item_id", itemId).maybeSingle()).data as { answers: Record<string, unknown>; revision: number } | null;
}

test.describe.serial("custom planning questions", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let staffDb: Awaited<ReturnType<typeof sessionFor>>;
  let eventId = "";
  let templateId = "";
  let planningUrl = "";
  let staffPlanningUrl = "";
  /** Keys and plan item ids of the custom items. */
  const keys = { section: "", stage: "", hora: "", party: "" };
  const items = { section: "", hora: "" };

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("custom", { catalog: true });
    staffDb = await sessionFor(tenant.ownerEmail);
    templateId = randomUUID();
    await must(staffDb.rpc("create_planning_template_once", {
      p_tenant_id: tenant.id, p_template_id: templateId, p_start: "basics", p_source_template_id: null as unknown as string, p_name: "Cultural wedding", p_description: null as unknown as string,
    }));
    const version = async () => (await must(admin.from("planning_templates").select("version").eq("id", templateId).single())).data!.version as number;
    await must(staffDb.rpc("add_planning_template_item", { p_template_id: templateId, p_expected_version: await version(), p_key: "party", p_parent_key: null as unknown as string }));
    const add = async (kind: string, label: string, parent?: string) =>
      ((await must(staffDb.rpc("add_custom_planning_template_item", { p_template_id: templateId, p_expected_version: await version(), p_kind: kind, p_label: label, p_parent_key: parent }))).data as { item_id: string; key: string });
    const section = await add("general", "Cultural music");
    const stage = await add("stage", "Cultural set");
    const hora = await add("moment", "Hora", stage.key);
    const party = await add("moment", "Late-night requests", "party");
    Object.assign(keys, { section: section.key, stage: stage.key, hora: hora.key, party: party.key });
    await must(staffDb.rpc("set_planning_template_item_questions", { p_item_id: section.item_id, p_expected_version: await version(), p_questions: CULTURAL }));
    await must(staffDb.rpc("set_planning_template_item_questions", { p_item_id: hora.item_id, p_expected_version: await version(), p_questions: HORA }));
    await must(staffDb.rpc("set_planning_template_item_questions", { p_item_id: party.item_id, p_expected_version: await version(), p_questions: [{ type: "short_text", label: "Any late-night requests?" }] }));

    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Eleni Pappas", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Cultural Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18", venue_name: "Salle E2E" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: templateId }));
    await bookEvent(tenant, eventId, clientEmail);
    await openPlanning(tenant, eventId);
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    const byKey = new Map(plan!.event_plan_items.map((i: { id: string; key: string }) => [i.key, i.id]));
    items.section = byKey.get(keys.section)!;
    items.hora = byKey.get(keys.hora)!;
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;

    staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    clientContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the template editor describes the DJ's own questions; its preview renders them and saves nothing", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates/${templateId}`);
    // The DJ's own section lists its questions in "Your questions" (built-in sections keep "What clients are asked").
    const questions = staff.getByTestId(`author-${keys.section}`);
    await questions.getByRole("button", { name: /Your questions \(7 questions\)/ }).click();
    await expect(questions).toContainText("Which traditions should the music include?");
    await expect(questions).toContainText("Single choice: Greek · Lebanese · Armenian");
    await expect(staff.getByTestId(`author-${keys.hora}`)).toHaveCount(1);
    await expect(staff.getByTestId("questions-basics")).toBeVisible();

    await staff.goto(`/staff/${tenant.slug}/planning-templates/${templateId}/preview?section=${keys.section}`);
    const editor = staff.getByTestId("client-preview").getByTestId(`editor-${keys.section}`);
    await expect(editor.getByTestId("item-needs")).toHaveCount(0); // progress isn't shown in a preview
    await editor.getByLabel("Family name to announce (optional)").fill("Preview family");
    await expect(editor.getByText("Preview: not saved")).toBeVisible();
    await editor.getByTestId("question-q_style").getByText("Lebanese").click();
    await expect(editor.getByTestId("question-q_style").getByRole("radio", { name: "Lebanese" })).toBeChecked();
    expect((await must(admin.from("event_plan_responses").select("id").eq("item_id", items.section))).data).toEqual([]);
  });

  test("the client answers the custom section with the planning inputs; incomplete answers save; required ones drive Still needed", async () => {
    await client.goto(planningUrl);
    const panel = await openPlanSection(client, keys.section);
    const editor = panel.getByTestId(`editor-${keys.section}`);
    await expect(editor.getByTestId("item-needs")).toContainText("Still needed: Which traditions should the music include?, Traditional songs, Will there be a hora?");

    await editor.getByLabel("Family name to announce (optional)").fill("Papadopoulos");
    await expect.poll(async () => (await answersOf(items.section))?.answers).toEqual({ q_name: "Papadopoulos" });

    await editor.getByTestId("question-q_style").getByText("Greek").click();
    await editor.getByTestId("question-q_hora").getByText("No", { exact: true }).click();
    await editor.getByTestId("question-q_langs").getByText("French").click();
    await editor.getByLabel("When should the cultural set start? (optional)").fill("23:30");
    await editor.getByLabel("Anything the DJ should know? (optional)").fill("Grandmother requests Misirlou.");
    await addSong(editor.getByTestId("question-q_songs"), { title: "Zorba's Dance", artist: "Mikis Theodorakis" });
    await expect(editor.getByTestId("question-q_songs").getByTestId("song-row")).toHaveCount(1);
    await expect.poll(async () => (await answersOf(items.section))?.answers).toMatchObject({
      q_name: "Papadopoulos", q_style: "o_greek", q_hora: false, q_langs: ["o_fr"], q_when: { time: "23:30" }, q_notes: "Grandmother requests Misirlou.",
      q_songs: [{ title: "Zorba's Dance", artist: "Mikis Theodorakis" }],
    });
    await expect(editor.getByTestId("item-needs")).toHaveCount(0);
    await expect(editor.getByText("All changes saved")).toBeVisible();
  });

  test("a custom stage's own moment and a custom moment in a library stage", async () => {
    const hora = await openPlanMoment(client, keys.stage, keys.hora);
    await expect(hora.getByTestId("item-needs")).toContainText("When does the hora start?");
    await hora.getByLabel("When does the hora start? (needed)").fill("22:15");
    await hora.getByLabel("Who leads it? (optional)").fill("Uncle Nikos");
    await expect.poll(async () => (await answersOf(items.hora))?.answers).toEqual({ q_start: { time: "22:15" }, q_lead: "Uncle Nikos" });
    const party = await openPlanMoment(client, "party", keys.party);
    await expect(party.getByLabel("Any late-night requests? (optional)")).toBeVisible();

    // Phones: the same section, without sideways scrolling.
    await client.setViewportSize({ width: 390, height: 844 });
    await client.goto(`${planningUrl}?section=${keys.section}`);
    await expect(client.getByTestId(`editor-${keys.section}`).getByLabel("Family name to announce (optional)")).toHaveValue("Papadopoulos");
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
    await client.setViewportSize({ width: 1280, height: 900 });
  });

  test("staff remove an answered question and a chosen option: answers are kept, readable by staff, gone from the client's form", async () => {
    const before = await answersOf(items.section);
    const version = (await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single())).data!.structure_version as number;
    await must(staffDb.rpc("set_event_plan_item_questions", {
      p_item_id: items.section, p_expected_version: version,
      p_questions: CULTURAL.filter((q) => q.id !== "q_name").map((q) => (q.id === "q_style" ? { ...q, options: q.options!.filter((o) => o.id !== "o_greek") } : q)),
    }));
    expect(await answersOf(items.section)).toEqual(before);

    await staff.goto(`${staffPlanningUrl}?section=${keys.section}`);
    const staffEditor = staff.getByTestId(`staff-section-${keys.section}`).getByTestId(`editor-${keys.section}`);
    await expect(staffEditor.getByTestId("questions-no-longer-asked")).toContainText("Family name to announce: Papadopoulos");
    await expect(staffEditor.getByTestId("question-q_style").getByRole("radio", { name: /Greek/ })).toBeChecked();
    await expect(staffEditor.getByTestId("question-q_style")).toContainText("No longer offered");

    await client.goto(`${planningUrl}?section=${keys.section}`);
    const editor = client.getByTestId(`editor-${keys.section}`);
    await expect(editor.getByLabel("Family name to announce (optional)")).toHaveCount(0);
    await expect(editor.getByTestId("question-q_style").getByRole("radio", { name: /Greek/ })).toBeChecked();
    // The client keeps answering; the removed question's answer stays as it was.
    await editor.getByLabel("Anything the DJ should know? (optional)").fill("Misirlou, please.");
    await expect.poll(async () => (await answersOf(items.section))?.answers).toMatchObject({ q_notes: "Misirlou, please.", q_name: "Papadopoulos", q_style: "o_greek" });
  });

  test("the run sheet lists the custom answers; Preview as client shows them and saves nothing", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/run-sheet`);
    const section = staff.getByTestId("run-custom-section");
    await expect(section).toContainText("Cultural music");
    await expect(section).toContainText("Greek (no longer offered)");
    await expect(section).toContainText("Family name to announce (no longer asked)");
    await expect(section).toContainText("Zorba's Dance · Mikis Theodorakis");
    await expect(section).toContainText("11:30 p.m.");
    await expect(staff.getByText("Who leads it?: Uncle Nikos")).toBeVisible();

    const saved = await answersOf(items.section);
    await staff.goto(`${staffPlanningUrl}/preview?section=${keys.section}`);
    const editor = staff.getByTestId("client-preview").getByTestId(`editor-${keys.section}`);
    await expect(editor.getByLabel("Anything the DJ should know? (optional)")).toHaveValue("Misirlou, please.");
    await expect(editor.getByLabel("Family name to announce (optional)")).toHaveCount(0);
    await editor.getByLabel("Anything the DJ should know? (optional)").fill("Typed in the preview");
    await expect(editor.getByText("Preview: not saved")).toBeVisible();
    expect(await answersOf(items.section)).toEqual(saved);
  });
});
