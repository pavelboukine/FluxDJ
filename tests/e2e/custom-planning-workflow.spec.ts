/**
 * The whole custom planning workflow through the screens, in the order a DJ works:
 * create a template from an outline, add "Cultural music preferences" with questions of several
 * types (a choice, songs, yes/no, a short answer), save, preview it; set up an event's planning from
 * that template (its questions are copied), preview the event as the client before opening it, open
 * planning without emailing (manual activation), the client answers, staff see the answers, and the
 * run sheet lists them. Editing the template afterwards never changes the event's plan.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { bookEvent, must } from "./booking";
import { admin, openPlanSection, signInStaff, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-workflow-${run}@example.test`;
const SECTION = "Cultural music preferences";
const STYLE = "Which traditions should the music include?";

async function addQuestion(author: Locator, q: { label: string; type?: string; required?: boolean; choices?: string[] }) {
  await author.getByRole("button", { name: "Add a question" }).click();
  await author.getByLabel("Question", { exact: true }).fill(q.label);
  if (q.type) await author.getByLabel("Answer type").selectOption({ label: q.type });
  if (q.required) await author.getByLabel("Needed to complete planning").check();
  for (const [i, choice] of (q.choices ?? []).entries()) {
    if (i >= 2) await author.getByRole("button", { name: "Add a choice" }).click();
    await author.getByLabel(`Choice ${i + 1}`, { exact: true }).fill(choice);
  }
}

type Stored = { id: string; key: string; label: string; questions: { id: string; type: string; label: string; required: boolean; options?: { id: string; label: string }[] }[] };

test.describe.serial("custom planning, from template to run sheet", () => {
  let staffContext: BrowserContext;
  let staff: Page;
  let client: Page;
  let templateId = "";
  let eventId = "";
  let template: Stored;
  let planItem: Stored;

  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("workflow", { catalog: true });
    staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("1–5: a template from an outline, with the DJ's own section and its questions, saved and previewed", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates/new`);
    await staff.getByRole("radio", { name: /^Simple Party outline/ }).check();
    await staff.getByLabel("Template name").fill("Cultural party");
    await staff.getByRole("button", { name: "Create template" }).click();
    await expect(staff.getByRole("heading", { name: "Cultural party" })).toBeVisible();
    templateId = staff.url().split("/").pop()!;

    await staff.getByRole("button", { name: "Create your own section" }).click();
    await staff.getByRole("textbox", { name: "Name of the new section" }).fill(SECTION);
    await staff.getByRole("button", { name: "Create section" }).click();
    const author = staff.locator('[data-testid^="author-custom_"]');
    await expect(author.getByText("No questions yet.")).toBeVisible();
    await addQuestion(author, { label: STYLE, type: "Single choice", required: true, choices: ["Greek", "Lebanese", "Armenian"] });
    await addQuestion(author, { label: "Traditional songs", type: "Songs", required: true });
    await addQuestion(author, { label: "Will there be a hora?", type: "Yes / No" });
    await addQuestion(author, { label: "Family name to announce" });
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toContainText("Saved.");
    template = (await must(admin.from("planning_template_items").select("id, key, label, questions").eq("template_id", templateId).eq("label", SECTION).single())).data as Stored;
    expect(template.questions.map((q) => [q.type, q.label, q.required])).toEqual([
      ["single_choice", STYLE, true], ["songs", "Traditional songs", true], ["yes_no", "Will there be a hora?", false], ["short_text", "Family name to announce", false],
    ]);

    // The preview shows the real controls, and saves nothing.
    await staff.getByRole("link", { name: "Preview", exact: true }).click();
    await staff.waitForURL(/\/preview$/);
    await staff.goto(`${staff.url()}?section=${template.key}`);
    const preview = staff.getByTestId("client-preview").getByTestId(`editor-${template.key}`);
    await expect(preview.getByTestId(`question-${template.questions[0].id}`).getByRole("radio", { name: "Armenian" })).toBeVisible();
    await expect(preview.getByTestId(`question-${template.questions[1].id}`).getByTestId(/-add$/).locator("summary")).toBeVisible();
    await expect(preview.getByTestId(`question-${template.questions[2].id}`).getByRole("radio", { name: "No" })).toBeVisible();
    await expect(preview.getByLabel("Family name to announce (optional)")).toBeVisible();
  });

  test("6–8: an event's planning set up from it copies the questions; Preview as client works before opening", async () => {
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Eleni Pappas", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Cultural Party ${run}`, event_type: "private_party", event_date: "2027-10-16", venue_name: "Salle E2E" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning`);
    await staff.getByLabel("Template").selectOption({ label: "Cultural party" });
    await staff.getByRole("button", { name: "Set up planning" }).click();
    await expect(staff.getByTestId("preview-as-client")).toBeVisible();
    const plan = (await must(admin.from("event_plans").select("id, client_opened_at").eq("event_id", eventId).single())).data!;
    planItem = (await must(admin.from("event_plan_items").select("id, key, label, questions").eq("plan_id", plan.id).eq("key", template.key).single())).data as Stored;
    expect(planItem.questions).toEqual(template.questions);
    expect(plan.client_opened_at).toBeNull();

    await staff.getByTestId("preview-as-client").click();
    await expect(staff.getByTestId("preview-note")).toContainText("Your client can't see this yet");
    await staff.goto(`${staff.url().split("?")[0]}?section=${planItem.key}`);
    await expect(staff.getByTestId("client-preview").getByText(STYLE)).toBeVisible();
  });

  test("9–12: opened without emailing, the client answers; staff and the run sheet show the answers", async ({ browser }) => {
    await bookEvent(tenant, eventId, clientEmail);
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const access = staff.getByTestId("client-access");
    staff.once("dialog", (d) => void d.accept());
    await access.getByTestId("open-without-emailing").getByRole("button", { name: "Open without emailing" }).click();
    await expect(access).toHaveAttribute("data-opened", "true");

    const clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInWithLink(client, clientEmail);
    await client.goto(`/${tenant.slug}/planning/${eventId}`);
    const panel = await openPlanSection(client, planItem.key);
    const [style, songs, hora] = planItem.questions;
    await panel.getByTestId(`question-${style.id}`).getByText("Lebanese").click();
    await panel.getByTestId(`question-${hora.id}`).getByText("Yes", { exact: true }).click();
    await panel.getByLabel("Family name to announce (optional)").fill("Haddad");
    const add = panel.getByTestId(`question-${songs.id}`).getByTestId(/-add$/);
    await add.locator("summary").click();
    await add.getByLabel("Title", { exact: true }).fill("Ya Msafer Wahdak");
    await add.getByLabel("Artist", { exact: true }).fill("Mohammed Abdel Wahab");
    await add.getByRole("button", { name: "Add song" }).click();
    await expect.poll(async () => (await admin.from("event_plan_responses").select("answers").eq("item_id", planItem.id).maybeSingle()).data?.answers).toMatchObject({
      [style.id]: style.options!.find((o) => o.label === "Lebanese")!.id, [hora.id]: true, [planItem.questions[3].id]: "Haddad",
      [songs.id]: [{ title: "Ya Msafer Wahdak", artist: "Mohammed Abdel Wahab" }],
    });
    await expect(panel.getByTestId("item-needs")).toHaveCount(0);
    expect(await client.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning?section=${planItem.key}`);
    const staffSection = staff.getByTestId(`staff-section-${planItem.key}`);
    await expect(staffSection.getByTestId(`question-${style.id}`).getByRole("radio", { name: "Lebanese" })).toBeChecked();
    await expect(staffSection.getByLabel("Family name to announce (optional)")).toHaveValue("Haddad");
    await expect(staffSection.getByTestId("song-row")).toContainText("Ya Msafer Wahdak");

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/run-sheet`);
    const sheet = staff.getByTestId("run-custom-section");
    await expect(sheet).toContainText(SECTION);
    for (const text of [STYLE, "Lebanese", "Will there be a hora?", "Yes", "Ya Msafer Wahdak · Mohammed Abdel Wahab", "Haddad"]) await expect(sheet).toContainText(text);
    await clientContext.close();
  });

  test("editing the template afterwards never changes the event's plan", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates/${templateId}`);
    const author = staff.getByTestId(`author-${template.key}`);
    await author.getByRole("button", { name: /Your questions/ }).click();
    await author.getByRole("button", { name: "Edit Family name to announce" }).click();
    await author.getByLabel("Question", { exact: true }).fill("Family name, as announced");
    await author.getByRole("button", { name: "Save questions" }).click();
    await expect(author.getByTestId("author-status")).toContainText("Saved.");

    const after = (await must(admin.from("event_plan_items").select("questions").eq("id", planItem.id).single())).data as Pick<Stored, "questions">;
    expect(after.questions).toEqual(planItem.questions);
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}/planning?section=${planItem.key}`);
    await expect(staff.getByTestId(`staff-section-${planItem.key}`).getByLabel("Family name to announce (optional)")).toHaveValue("Haddad");
  });
});
