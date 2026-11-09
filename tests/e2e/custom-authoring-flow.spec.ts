/**
 * Authoring a DJ's own planning content, end to end through the screens: in a template, create a
 * section, a stage and a moment, write their questions (types, help, needed, choices), reorder and
 * remove them, with the editor pointing at what can't be saved; a stale tab's save is refused, never
 * overwriting; the template preview shows the result. For one event, the same authoring adds content
 * without touching the template, before planning is open; once the client has answered, staff
 * can't change an answered question's type, and removing a question or a choice keeps the answers
 * (shown to staff, gone from the client's form). The template editor stays usable on a phone.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, must, openPlanning, sessionFor } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-authoring-${run}@example.test`;

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Creates the DJ's own item from its "Create your own …" button. */
async function createOwn(scope: Page | Locator, button: string | RegExp, name: string) {
  await scope.getByRole("button", { name: button }).click();
  const input = scope.getByRole("textbox", { name: /^Name of the new / });
  await input.fill(name);
  await input.press("Enter");
}

/** Adds a question in an open "Your questions" editor and fills it in. */
async function addQuestion(author: Locator, q: { label: string; type?: string; required?: boolean; help?: string; choices?: string[] }) {
  await author.getByRole("button", { name: "Add a question" }).click();
  await author.getByLabel("Question", { exact: true }).fill(q.label);
  if (q.type) await author.getByLabel("Answer type").selectOption({ label: q.type });
  if (q.help) await author.getByLabel(/^Help text/).fill(q.help);
  if (q.required) await author.getByLabel("Needed to complete planning").check();
  for (const [i, choice] of (q.choices ?? []).entries()) {
    if (i >= 2) await author.getByRole("button", { name: "Add a choice" }).click();
    await author.getByLabel(`Choice ${i + 1}`, { exact: true }).fill(choice);
  }
}

const questionLabels = (author: Locator) => author.getByTestId("author-question-label").allInnerTexts();

async function itemByLabel(table: "planning_template_items" | "event_plan_items", parent: Record<string, string>, label: string) {
  const { data } = await must(admin.from(table).select("id, key, questions").match(parent).eq("label", label).single());
  return data as { id: string; key: string; questions: { id: string; type: string; label: string; required: boolean; options?: { id: string; label: string; archived?: boolean }[]; archived?: boolean }[] | null };
}

test.describe.serial("authoring custom planning content", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let templateId = "";
  let templateUrl = "";
  let eventId = "";
  let planId = "";
  let sectionKey = "";

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("authoring", { catalog: true });
    const staffDb = await sessionFor(tenant.ownerEmail);
    templateId = randomUUID();
    await must(staffDb.rpc("create_planning_template_once", {
      p_tenant_id: tenant.id, p_template_id: templateId, p_start: "basics", p_source_template_id: null as unknown as string, p_name: "Cultural wedding", p_description: null as unknown as string,
    }));
    templateUrl = `/staff/${tenant.slug}/planning-templates/${templateId}`;
    staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("a template: create your own section with questions of several types, reorder, fix and remove, then save", async () => {
    await staff.goto(templateUrl);
    await createOwn(staff, "Create your own section", "Cultural music");
    const row = staff.locator('[data-testid^="row-custom_"]').filter({ hasText: "Cultural music" });
    await expect(row.getByText("Your own")).toBeVisible();
    const author = row.locator('[data-testid^="author-"]').first();
    // A new section opens on its (empty) questions.
    await expect(author.getByText("No questions yet.")).toBeVisible();
    // Built-in content keeps its read-only summary.
    await expect(staff.getByTestId("questions-basics").getByRole("button", { name: /What clients are asked/ })).toBeVisible();

    await addQuestion(author, { label: "Which traditions should the music include?", type: "Single choice", required: true, choices: ["Greek", "Lebanese", "Armenian"] });
    await addQuestion(author, { label: "Traditional songs", type: "Songs", help: "Songs your families will expect." });
    await addQuestion(author, { label: "Family name to announce" });
    await expect(author.getByTestId("author-status")).toHaveText("Unsaved changes");
    await expect(row.getByRole("button", { name: /Your questions \(3 questions\)/ })).toContainText("Not saved");

    // Nothing invalid is sent: an empty question is pointed at, then removed.
    await author.getByRole("button", { name: "Add a question" }).click();
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toHaveText("Not saved: Write the question.");
    await author.getByRole("button", { name: "Remove question" }).click();

    // Reorder: the family name first.
    await author.getByRole("button", { name: "Move Family name to announce up" }).click();
    await author.getByRole("button", { name: "Move Family name to announce up" }).click();
    expect(await questionLabels(author)).toEqual(["1. Family name to announce", "2. Which traditions should the music include?", "3. Traditional songs"]);
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toHaveText("Saved. Events whose planning starts from now on get these questions.");
    const section = await itemByLabel("planning_template_items", { template_id: templateId }, "Cultural music");
    sectionKey = section.key;
    expect(section.questions!.map((q) => [q.label, q.type, q.required])).toEqual([
      ["Family name to announce", "short_text", false],
      ["Which traditions should the music include?", "single_choice", true],
      ["Traditional songs", "songs", false],
    ]);
    expect(section.questions![1].options!.map((o) => o.label)).toEqual(["Greek", "Lebanese", "Armenian"]);
    // No internal keys or JSON on the page.
    await expect(staff.getByText(/custom_[a-z0-9]{6,}/)).toHaveCount(0);
  });

  test("a template: your own stage with a moment in it, and a moment in a library stage", async () => {
    await createOwn(staff, "Create your own stage", "Cultural set");
    const stage = staff.locator('[data-testid^="stage-custom_"]').filter({ hasText: "Cultural set" });
    await createOwn(stage, "Create your own moment in Cultural set", "Hora");
    const hora = stage.locator('[data-testid^="row-custom_"]').filter({ hasText: "Hora" });
    const author = hora.locator('[data-testid^="author-"]').first();
    await addQuestion(author, { label: "When does the hora start?", type: "Time", required: true });
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toContainText("Saved.");
    const moment = await itemByLabel("planning_template_items", { template_id: templateId }, "Hora");
    expect(moment.questions!.map((q) => q.type)).toEqual(["time"]);

    // The template preview renders what was written, through the client's own planning page.
    await staff.goto(`${templateUrl}/preview?section=${sectionKey}`);
    const preview = staff.getByTestId("client-preview");
    await expect(preview.getByLabel("Family name to announce (optional)")).toBeVisible();
    await expect(preview.getByTestId(/^question-/).filter({ hasText: "Which traditions should the music include?" }).getByText("Armenian")).toBeVisible();
  });

  test("two tabs: the stale one's save is refused and keeps its typing; nothing is overwritten", async () => {
    await staff.goto(templateUrl);
    const stalePage = await staffContext.newPage();
    await stalePage.goto(templateUrl);
    const open = async (page: Page) => {
      const author = page.locator(`[data-testid="author-${sectionKey}"]`);
      await author.getByRole("button", { name: /Your questions/ }).click();
      return author;
    };
    const fresh = await open(staff);
    await fresh.getByRole("button", { name: "Edit Family name to announce" }).click();
    await fresh.getByLabel("Question", { exact: true }).fill("Family name, as announced");
    await fresh.getByRole("button", { name: "Save questions" }).click();
    await expect(fresh.getByTestId("author-status")).toContainText("Saved.");

    const stale = await open(stalePage);
    await stale.getByRole("button", { name: "Edit Traditional songs" }).click();
    await stale.getByLabel("Needed to complete planning").check();
    await stale.getByRole("button", { name: "Save questions" }).click();
    await expect(stale.getByTestId("author-status")).toHaveText("Someone else saved changes first. Reload the page to see them, then try again.");
    await expect(stale.getByLabel("Needed to complete planning")).toBeChecked();
    const section = await itemByLabel("planning_template_items", { template_id: templateId }, "Cultural music");
    expect(section.questions!.map((q) => [q.label, q.required])).toEqual([
      ["Family name, as announced", false], ["Which traditions should the music include?", true], ["Traditional songs", false],
    ]);
    await stalePage.close();
  });

  test("one event: its own content without touching the template, before planning is open; Preview as client shows it", async () => {
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Eleni Pappas", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Authoring Wedding ${run}`, event_type: "wedding", event_date: "2027-10-02", venue_name: "Salle E2E" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: templateId }));
    planId = (await must(admin.from("event_plans").select("id").eq("event_id", eventId).single())).data!.id as string;

    const planning = `/staff/${tenant.slug}/events/${eventId}/planning`;
    await staff.goto(`${planning}?section=plan-structure`);
    const structure = staff.getByTestId("staff-structure");
    await createOwn(structure, "Create your own section", "Family traditions");
    const row = structure.locator("li").filter({ has: staff.locator('[data-testid^="author-"]') }).filter({ hasText: "Family traditions" });
    const author = row.locator('[data-testid^="author-"]').first();
    await addQuestion(author, { label: "Will there be a money dance?", type: "Yes / No", required: true });
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toHaveText("Saved. Your client sees these questions once planning is open to them.");
    expect((await itemByLabel("event_plan_items", { plan_id: planId }, "Family traditions")).questions!.map((q) => q.type)).toEqual(["yes_no"]);
    expect((await must(admin.from("planning_template_items").select("id").eq("template_id", templateId).eq("label", "Family traditions"))).data).toEqual([]);
    expect((await must(admin.from("event_plans").select("client_opened_at").eq("id", planId).single())).data!.client_opened_at).toBeNull();

    const families = await itemByLabel("event_plan_items", { plan_id: planId }, "Family traditions");
    await staff.goto(`${planning}/preview?section=${families.key}`);
    await expect(staff.getByTestId("client-preview").getByTestId("question-" + families.questions![0].id)).toContainText("Will there be a money dance?");
  });

  test("after the client answers: no type change for answered questions; removing a question or a choice keeps the answers", async ({ browser }) => {
    await bookEvent(tenant, eventId, clientEmail);
    await openPlanning(tenant, eventId);
    clientContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    const section = await itemByLabel("event_plan_items", { plan_id: planId }, "Cultural music");
    await client.goto(`/${tenant.slug}/planning/${eventId}`);
    const panel = await openPlanSection(client, section.key);
    await panel.getByLabel("Family name, as announced (optional)").fill("Papadopoulos");
    await panel.getByTestId(`question-${section.questions![1].id}`).getByText("Greek").click();
    await expect.poll(async () => (await must(admin.from("event_plan_responses").select("answers").eq("item_id", section.id).maybeSingle())).data?.answers)
      .toEqual({ [section.questions![0].id]: "Papadopoulos", [section.questions![1].id]: section.questions![1].options![0].id });

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning?section=plan-structure`);
    const author = staff.getByTestId(`author-${section.key}`);
    await author.getByRole("button", { name: /Your questions/ }).click();
    await expect(author.getByTestId("author-question").filter({ hasText: "Family name, as announced" }).getByText("Has answers")).toBeVisible();
    await author.getByRole("button", { name: "Edit Which traditions should the music include?" }).click();
    await expect(author.getByLabel("Answer type")).toBeDisabled();
    await expect(author.getByText("It already has answers, so its type stays.")).toBeVisible();
    await author.getByRole("button", { name: "Remove choice 1 (Greek)" }).click();
    await author.getByRole("button", { name: "Done editing Which traditions should the music include?" }).click();
    await author.getByRole("button", { name: "Edit Family name, as announced" }).click();
    staff.once("dialog", (d) => d.accept());
    await author.getByRole("button", { name: "Remove question" }).click();
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toContainText("Saved.");
    await expect(author.getByText("1 removed question is kept with the answers given")).toBeVisible();
    // Removed questions aren't offered for editing.
    expect(await questionLabels(author)).toEqual(["1. Which traditions should the music include?", "2. Traditional songs"]);

    const after = await itemByLabel("event_plan_items", { plan_id: planId }, "Cultural music");
    expect(after.questions!.find((q) => q.label === "Family name, as announced")).toMatchObject({ archived: true });
    expect(after.questions!.find((q) => q.type === "single_choice")!.options!.find((o) => o.label === "Greek")).toMatchObject({ archived: true });
    expect((await must(admin.from("event_plan_responses").select("answers").eq("item_id", section.id).single())).data!.answers)
      .toEqual({ [section.questions![0].id]: "Papadopoulos", [section.questions![1].id]: section.questions![1].options![0].id });

    // Staff still read the kept answer; the client no longer sees the question.
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning?section=${section.key}`);
    await expect(staff.getByTestId("questions-no-longer-asked")).toContainText("Family name, as announced: Papadopoulos");
    await client.reload();
    await expect(client.getByLabel("Family name, as announced (optional)")).toHaveCount(0);
  });

  test("on a phone: the template's authoring fits without sideways scrolling", async () => {
    await staff.setViewportSize({ width: 390, height: 844 });
    await staff.goto(templateUrl);
    const author = staff.getByTestId(`author-${sectionKey}`);
    await author.getByRole("button", { name: /Your questions/ }).click();
    await author.getByRole("button", { name: "Edit Which traditions should the music include?" }).click();
    await expect(author.getByLabel("Choice 3", { exact: true })).toBeVisible();
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);

    // The event's Structure panel: the same rows and "Your questions", without sideways scrolling.
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning?section=plan-structure`);
    const structure = staff.getByTestId("staff-structure");
    const families = structure.getByTestId(/^row-custom_/).filter({ hasText: "Family traditions" });
    await expect(families.getByText("Your own")).toBeVisible();
    await families.getByRole("button", { name: /Your questions/ }).click();
    await families.getByRole("button", { name: "Edit Will there be a money dance?" }).click();
    await expect(families.getByLabel("Answer type")).toBeVisible();
    await structure.getByRole("button", { name: "Rename Family traditions" }).click();
    await expect(structure.getByLabel("Label for Family traditions")).toBeVisible();
    await expect(structure.getByText(/custom_[a-z0-9]{6,}/)).toHaveCount(0);
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
  });
});
