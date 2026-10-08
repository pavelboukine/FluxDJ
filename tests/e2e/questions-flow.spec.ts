/**
 * Questions & rules in real browsers, in dedicated test businesses: the list
 * (empty, populated, search, archived on request, Clear filters, pages), a
 * question's page (its choices and their rules, templates that ask it,
 * rules as readable statements with the packages that include their gear),
 * creating each kind of question with choices (stable values when labels
 * change, validation keeping input, a lost reply never duplicating), choices
 * used by rules protected, adding rules (a repeat or a lost reply never
 * doubling a requirement), editing, archiving and restoring rules and
 * questions, quantities checked against the pricing engine on a real
 * frozen proposal, which edits never change, other businesses and suspended
 * workspaces refused, and phone layouts. E2E_SCREENSHOTS=1 keeps review
 * screenshots in review-samples/templates-questions.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";
import { parseOfferSnapshot, priceSelection } from "../../src/lib/pricing";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const REVIEW = "review-samples/templates-questions";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page: Page, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(REVIEW, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: `${REVIEW}/${name}.png`, fullPage });
}

/** Drops the first POST reply after the server has handled it (a lost response). */
async function loseNextReply(page: Page, url: string) {
  let dropped = false;
  await page.route(url, async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch().catch(() => null);
      return route.abort();
    }
    return route.continue();
  });
}

test.describe.serial("questions and rules", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let empty: TestTenant;
  let other: TestTenant;
  let suspended: TestTenant;
  const run = randomUUID().slice(0, 6);
  const ids: Record<string, string> = {};
  let createdId = "";

  const id = async (table: "gear_items" | "logistics_questions" | "proposal_templates", column: string, value: string) =>
    (await must(admin.from(table).select("id").eq("tenant_id", tenant.id).eq(column, value).single())).data!.id as string;
  const rulesOf = async (questionId: string) =>
    (await must(admin.from("logistics_rules").select("id, condition, gear_item_id, required_quantity, reason, active").eq("question_id", questionId).order("created_at"))).data!;

  async function staffPage(t: TestTenant, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 1000 } }) {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, t.ownerEmail);
    return page;
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("questions", { catalog: true });
    empty = await createTestTenant("questions-empty");
    other = await createTestTenant("questions-other");
    suspended = await createTestTenant("questions-suspended", { catalog: true });
    ids.ceremony = await id("logistics_questions", "key", "ceremony_location");
    ids.cocktail = await id("logistics_questions", "key", "cocktail_location");
    ids.speaker = await id("gear_items", "key", "additional_location_speaker");
    ids.uplights = await id("gear_items", "key", "uplights_4");
    ids.wedding = await id("proposal_templates", "name", "Wedding (DEMO)");
    await must(
      admin.from("logistics_questions").insert(
        Array.from({ length: 22 }, (_, i) => ({ tenant_id: tenant.id, key: `filler_${i + 1}`, prompt: `Filler question ${String(i + 1).padStart(2, "0")}?`, answer_type: "boolean", options: [], sort_order: 50 + i })),
      ),
    );
    await must(admin.from("logistics_questions").insert({ tenant_id: tenant.id, key: "old_strobe", prompt: "Old: strobe lights allowed (100%_sure)?", answer_type: "boolean", options: [], active: false, sort_order: 99 }));
  });

  test.afterAll(async () => {
    for (const t of [tenant, empty, other, suspended]) await archiveTestTenant(t);
  });

  test("list: empty business, rows with type, rules and templates, search, archived, Clear filters, pages", async () => {
    const blank = await staffPage(empty);
    await blank.goto(`/staff/${empty.slug}/questions`);
    await expect(blank.getByTestId("questions-empty")).toContainText("No questions yet.");
    await expect(blank.getByRole("main").getByRole("link", { name: "Add question" })).toHaveAttribute("href", `/staff/${empty.slug}/questions/new`);
    await blank.context().close();

    const page = await staffPage(tenant);
    const base = `/staff/${tenant.slug}/questions`;
    await page.goto(base);
    const rows = page.getByTestId("question-row");
    await expect(rows).toHaveCount(25);
    await expect(page.getByTestId("list-result")).toContainText("26 active questions, in display order. Showing 1–25 of 26. 1 archived question also matches.");
    await expect(rows.nth(0).getByTestId("question-summary")).toHaveText("One choice · Required · 1 rule · in 1 template");
    await expect(rows.nth(3).getByTestId("question-summary")).toHaveText("Short text · Optional · can't have rules · in 1 template");
    await shot(page, "questions-list-desktop");
    await page.getByRole("link", { name: "Next" }).click();
    await expect(rows).toHaveCount(1);
    await page.goto(`${base}?q=${encodeURIComponent("100%_sure")}`);
    await expect(page.getByTestId("questions-no-results")).toContainText("1 archived question matches but is hidden.");
    await page.getByTestId("questions-no-results").getByRole("link", { name: "Include archived" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Archived");
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(page.getByLabel("Include archived")).not.toBeChecked();
    await page.context().close();
  });

  test("a question's page: choices, templates, rules as statements with package inclusions", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/questions/${ids.ceremony}`);
    await expect(page.getByTestId("question-choices")).toContainText("A separate space · used by a rule");
    await expect(page.getByTestId("question-templates").getByRole("link", { name: "Wedding (DEMO)" })).toHaveAttribute("href", `/staff/${tenant.slug}/templates/${ids.wedding}`);
    const rule = page.getByTestId("rule-item");
    await expect(rule.getByRole("heading")).toHaveText("When “DEMO: Where will the ceremony take place?” is “A separate space”, require 1 × Additional-location speaker.");
    await expect(rule).toContainText("Client sees: “DEMO: Your ceremony is in a separate space, so it needs its own speaker.”");
    await expect(rule).toContainText("included in Signature (1), Premium (2)");
    await expect(page.getByTestId("rules-explainer")).toContainText("their quantities add up for each gear item");
    await expect(page.getByTestId("rules-explainer")).toContainText("Units the chosen package already includes count toward that total");
    await expect(page.getByLabel("Question", { exact: true })).toBeHidden();
    await shot(page, "question-page-desktop");
    await page.context().close();
  });

  test("create a choice question: choices, validation keeping input, a lost reply not duplicating", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/questions`);
    await page.getByRole("main").getByRole("link", { name: "Add question" }).click();
    const prompt = `Where will the first dance be? ${run}`;
    await page.getByLabel("Question", { exact: true }).fill(prompt);
    await expect(page.getByRole("radio", { name: /^One choice/ })).toBeChecked();
    await page.getByLabel("Choice 1", { exact: true }).fill("Main room");
    await page.getByRole("button", { name: "Add a choice" }).click();
    await expect(page.getByLabel("Choice 2", { exact: true })).toBeFocused();
    await page.getByLabel("Choice 2", { exact: true }).fill("Terrace");
    await page.getByRole("button", { name: "Add a choice" }).click();
    await page.getByLabel("Choice 3", { exact: true }).fill("main room");
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Two choices have the same label.");
    await expect(page.getByLabel("Question", { exact: true })).toHaveValue(prompt);
    await expect(page.getByLabel("Choice 2", { exact: true })).toHaveValue("Terrace");
    await shot(page, "question-new-error");
    await page.getByLabel("Choice 3", { exact: true }).fill("Garden");
    await page.getByRole("button", { name: "Move Garden up" }).click();
    await expect(page.getByLabel("Choice 2", { exact: true })).toHaveValue("Garden");

    await loseNextReply(page, "**/questions/new");
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("didn't go through");
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByText("This question was already saved")).toBeVisible();
    const saved = (await must(admin.from("logistics_questions").select("id, options, answer_type, required").eq("tenant_id", tenant.id).eq("prompt", prompt))).data!;
    expect(saved).toHaveLength(1);
    createdId = saved[0].id;
    expect(saved[0]).toMatchObject({
      answer_type: "single_choice",
      required: true,
      options: [{ value: "main_room", label: "Main room" }, { value: "garden", label: "Garden" }, { value: "terrace", label: "Terrace" }],
    });
    await page.unroute("**/questions/new");
    await page.context().close();
  });

  test("rules: add, never twice, edit, archive; choices used by rules are protected", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/questions/${createdId}`);
    const add = page.getByRole("region", { name: "Add a rule" });
    await add.getByRole("checkbox", { name: "Garden" }).check();
    await add.getByRole("checkbox", { name: "Terrace", exact: true }).check();
    await add.getByLabel("Require this gear").selectOption(ids.speaker);
    await add.getByLabel("Quantity").fill("1");
    await add.getByLabel("Reason shown to the client").fill("Outdoor dancing needs its own speaker.");
    await loseNextReply(page, `**/questions/${createdId}`);
    await add.getByRole("button", { name: "Add rule" }).click();
    await expect(add.getByRole("alert")).toContainText("didn't go through");
    await expect(add.getByLabel("Reason shown to the client")).toHaveValue("Outdoor dancing needs its own speaker.");
    await add.getByRole("button", { name: "Add rule" }).click();
    await expect(add.getByRole("status").filter({ hasText: "This exact rule is already saved, so it wasn't added again. If you just retried, your first save went through." })).toBeVisible();
    await page.unroute(`**/questions/${createdId}`);
    expect(await rulesOf(createdId)).toHaveLength(1);
    const statement = `When “Where will the first dance be? ${run}” is “Garden” or “Terrace”, require 1 × Additional-location speaker.`;
    await page.reload();
    await expect(page.getByTestId("rule-item").getByRole("heading")).toHaveText(statement);

    // Edit the rule: quantity 2 and another gear.
    await page.getByRole("button", { name: "Edit rule" }).click();
    await page.getByLabel("Quantity").first().fill("0");
    await page.getByLabel("Quantity").first().evaluate((el: HTMLInputElement) => el.removeAttribute("min"));
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByTestId("rule-item").getByRole("alert")).toContainText("The quantity must be a whole number from 1 to 100.");
    await page.getByLabel("Quantity").first().fill("2");
    await page.getByTestId("rule-item").getByLabel("Require this gear").selectOption(ids.uplights);
    await shot(page, "rule-edit", false);
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByTestId("rule-item").getByRole("heading")).toHaveText(statement.replace("require 1 × Additional-location speaker", "require 2 × Uplights (pack of 4)"));
    const [rule] = await rulesOf(createdId);
    expect(rule).toMatchObject({ gear_item_id: ids.uplights, required_quantity: 2, condition: { op: "in", values: ["garden", "terrace"] }, active: true });

    // Renaming a choice keeps its value; a choice a rule uses can't be removed, even after archiving the rule.
    await page.getByRole("button", { name: "Edit question" }).click();
    await expect(page.getByRole("button", { name: "Remove Garden" })).toBeDisabled();
    await expect(page.getByTestId("choices-editor")).toContainText("Used by a rule (active or archived), so it can't be removed.");
    await page.getByLabel("Choice 2", { exact: true }).fill("Garden terrace");
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.locator("#question").getByRole("status").filter({ hasText: "Question saved." })).toBeVisible();
    expect((await must(admin.from("logistics_questions").select("options").eq("id", createdId).single())).data!.options).toContainEqual({ value: "garden", label: "Garden terrace" });

    await page.getByRole("button", { name: /^Archive rule:/ }).click();
    await expect(page.getByRole("button", { name: /^Restore rule:/ })).toBeVisible();
    await expect(page.getByTestId("rule-item")).toContainText("Archived rule: doesn't apply");
    // Forcing the removal anyway is refused by the database, with nothing saved.
    await page.getByRole("button", { name: "Edit question" }).click();
    await page.getByTestId("choice-row").nth(1).evaluate((li) => li.remove());
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.locator("#question").getByRole("alert")).toContainText("A rule (active or archived) uses a choice you removed.");
    expect(((await must(admin.from("logistics_questions").select("options").eq("id", createdId).single())).data!.options as unknown[]).length).toBe(3);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: /^Restore rule:/ }).click();
    await expect(page.getByRole("button", { name: /^Archive rule:/ })).toBeVisible();
    await page.context().close();
  });

  test("an edit or a restore can't make a second identical active rule", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/questions/${createdId}`);
    // A second, distinct rule: Main room requires 1 speaker.
    const add = page.getByRole("region", { name: "Add a rule" });
    await add.getByRole("checkbox", { name: "Main room" }).check();
    await add.getByLabel("Require this gear").selectOption(ids.speaker);
    await add.getByLabel("Reason shown to the client").fill("Main room dancing needs a speaker.");
    await add.getByRole("button", { name: "Add rule" }).click();
    await expect(add.getByRole("status").filter({ hasText: "Rule added." })).toBeVisible();
    const items = page.getByTestId("rule-item");
    await expect(items).toHaveCount(2);
    // Editing it into a copy of the first rule is refused, keeping the typed edit.
    const second = items.filter({ hasText: "Main room dancing" });
    await second.getByRole("button", { name: "Edit rule" }).click();
    await second.getByRole("checkbox", { name: "Main room" }).uncheck();
    await second.getByRole("checkbox", { name: "Garden terrace" }).check();
    await second.getByRole("checkbox", { name: "Terrace", exact: true }).check();
    await second.getByLabel("Require this gear").selectOption(ids.uplights);
    await second.getByLabel("Quantity").fill("2");
    await second.getByLabel("Reason shown to the client").fill("Outdoor dancing needs its own speaker.");
    await second.getByRole("button", { name: "Save rule" }).click();
    await expect(second.getByRole("alert")).toContainText("Another active rule already says exactly this");
    await expect(second.getByLabel("Quantity")).toHaveValue("2");
    page.once("dialog", (d) => d.accept());
    await second.getByRole("button", { name: "Cancel" }).click();
    // Archive the first rule, add the identical one again (allowed), then restoring the first is refused.
    await page.reload();
    const first = page.getByTestId("rule-item").filter({ hasText: "Outdoor dancing" });
    await first.getByRole("button", { name: /^Archive rule:/ }).click();
    await expect(first.getByRole("button", { name: /^Restore rule:/ })).toBeVisible();
    await add.getByRole("checkbox", { name: "Garden terrace" }).check();
    await add.getByRole("checkbox", { name: "Terrace", exact: true }).check();
    await add.getByLabel("Require this gear").selectOption(ids.uplights);
    await add.getByLabel("Quantity").fill("2");
    await add.getByLabel("Reason shown to the client").fill("Outdoor dancing needs its own speaker.");
    await add.getByRole("button", { name: "Add rule" }).click();
    await expect(add.getByRole("status").filter({ hasText: "Rule added." })).toBeVisible();
    const archived = page.getByTestId("rule-item").filter({ hasText: "Archived rule" });
    await archived.getByRole("button", { name: /^Restore rule:/ }).click();
    await expect(archived.getByRole("alert")).toContainText("Not restored: an identical rule is already active");
    const active = (await rulesOf(createdId)).filter((r) => r.active && r.reason === "Outdoor dancing needs its own speaker.");
    expect(active).toHaveLength(1);
    await page.context().close();
  });

  test("an edited rule reaches the next proposal: quantities add up and package inclusions count (pricing engine)", async () => {
    const page = await staffPage(tenant);
    // Cocktail hour in a separate space now requires 2 speakers (was 1).
    await page.goto(`/staff/${tenant.slug}/questions/${ids.cocktail}`);
    await page.getByRole("button", { name: "Edit rule" }).click();
    await page.getByLabel("Quantity").first().fill("2");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByTestId("rule-item").getByRole("heading")).toContainText("require 2 × Additional-location speaker");

    const clientId = randomUUID();
    const eventId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Rules Client", email: `e2e-rules-client-${run}@example.test` }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: "Rules wedding", event_type: "wedding", event_date: "2027-08-21", venue_name: "E2E Hall" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const proposalUrl = await sendProposalFromEventPage(page, tenant, eventId);
    const proposalId = proposalUrl.split("/").pop()!;
    const frozen = async () => (await must(admin.from("proposals").select("offer_snapshot, offer_sha256").eq("id", proposalId).single())).data!;
    const before = await frozen();
    const offer = parseOfferSnapshot(before.offer_snapshot);
    const answers = { ceremony_location: "separate_space", cocktail_location: "separate_space", speeches_wireless_mic: false };
    const signature = priceSelection(offer, { package_key: "signature", answers });
    const essential = priceSelection(offer, { package_key: "essential", answers });
    expect(signature.ok && essential.ok).toBe(true);
    if (!signature.ok || !essential.ok) return;
    const speaker = (r: typeof signature.selection) => r.requirements.find((x) => x.gear_key === "additional_location_speaker")!;
    // 1 (ceremony) + 2 (cocktail) = 3 required; Signature includes 1, so 2 are charged; Essential includes none, so 3.
    expect(speaker(signature.selection)).toMatchObject({ required_quantity: 3, included_quantity: 1, required_extra_quantity: 2 });
    expect(speaker(essential.selection)).toMatchObject({ required_quantity: 3, included_quantity: 0, required_extra_quantity: 3 });
    expect(signature.selection.lines.find((l) => l.item_key === "additional_location_speaker" && l.source === "required")).toMatchObject({ quantity: 2, unit_price_cents: 15_000 });

    // Later edits (rule and question) never change the sent proposal.
    await page.goto(`/staff/${tenant.slug}/questions/${ids.cocktail}`);
    await page.getByRole("button", { name: "Edit rule" }).click();
    await page.getByLabel("Quantity").first().fill("1");
    await page.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByTestId("rule-item").getByRole("heading")).toContainText("require 1 × Additional-location speaker");
    await page.getByRole("button", { name: "Edit question" }).click();
    await page.getByLabel("Question", { exact: true }).fill("Where will cocktails be served?");
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByRole("heading", { name: "Where will cocktails be served?", level: 1 })).toBeVisible();
    expect(await frozen()).toEqual(before);
    await page.context().close();
  });

  test("other answer types: yes/no and several choices; archiving a question explains its templates", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/questions/new`);
    await page.getByLabel("Question", { exact: true }).fill(`Which effects would you like? ${run}`);
    await page.getByRole("radio", { name: /^Several choices/ }).check();
    await page.getByLabel("Choice 1", { exact: true }).fill("Cold sparks");
    await page.getByRole("button", { name: "Add a choice" }).click();
    await page.getByLabel("Choice 2", { exact: true }).fill("Low fog");
    await page.getByLabel("An answer is required").uncheck();
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByText("Question created.")).toBeVisible();
    const add = page.getByRole("region", { name: "Add a rule" });
    await expect(add.getByRole("radio", { name: "Low fog" })).toBeVisible();
    await add.getByRole("radio", { name: "Low fog" }).check();
    await add.getByLabel("Require this gear").selectOption(ids.uplights);
    await add.getByLabel("Reason shown to the client").fill("Low fog looks best with uplights.");
    await add.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByTestId("rule-item").getByRole("heading")).toContainText("includes “Low fog”, require 1 × Uplights (pack of 4).");

    await page.goto(`/staff/${tenant.slug}/questions/new`);
    await page.getByLabel("Question", { exact: true }).fill(`Any notes for the DJ? ${run}`);
    await page.getByRole("radio", { name: /^Short text/ }).check();
    await expect(page.getByTestId("choices-editor")).toHaveCount(0);
    await page.getByRole("button", { name: "Save question" }).click();
    await expect(page.getByText("Short text answers can't trigger rules.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Add a rule" })).toHaveCount(0);

    // Archiving a question a template asks.
    await page.goto(`/staff/${tenant.slug}/questions/${ids.ceremony}`);
    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the question" });
    await expect(dialog).toContainText("1 template still asks it");
    await expect(dialog).toContainText("can't be previewed or sent until you remove it there or restore it");
    await shot(page, "question-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive question" }).click();
    await expect(page.getByText("This question is archived.")).toBeVisible();
    await page.goto(`/staff/${tenant.slug}/templates/${ids.wedding}`);
    await expect(page.getByTestId("template-problems")).toContainText("is archived.");
    await page.goto(`/staff/${tenant.slug}/questions/${ids.ceremony}`);
    await page.getByRole("button", { name: "Restore question" }).click();
    await expect(page.getByText("Question restored.")).toBeVisible();
    expect((await must(admin.from("proposal_template_questions").select("id").eq("question_id", ids.ceremony))).data).toHaveLength(1);
    await page.context().close();
  });

  test("another business and a suspended workspace are refused", async () => {
    const outsider = await staffPage(other);
    expect((await outsider.goto(`/staff/${tenant.slug}/questions`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${other.slug}/questions/${ids.ceremony}`))?.status()).toBe(404);
    await outsider.context().close();
    const page = await staffPage(suspended);
    await page.goto(`/staff/${suspended.slug}/questions`);
    await expect(page.getByTestId("question-row")).toHaveCount(4);
    suspendLocally(suspended.id);
    for (const path of ["questions", "questions/new"]) {
      await page.goto(`/staff/${suspended.slug}/${path}`);
      await expect(page).toHaveURL(/\/unavailable$/);
    }
    await page.context().close();
  });

  test("on a phone: list, question page and editors fit without sideways scrolling", async () => {
    for (const width of [390, 320]) {
      const page = await staffPage(tenant, { ...PHONE, viewport: { width, height: 844 } });
      for (const path of ["questions", "questions?archived=1&page=2", `questions/${ids.ceremony}`, `questions/${createdId}`, "questions/new"]) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await sideways(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      }
      await page.goto(`/staff/${tenant.slug}/questions/${createdId}`);
      await page.getByRole("button", { name: "Edit question" }).click();
      await page.getByRole("button", { name: "Edit rule" }).first().click();
      expect(await sideways(page), `editing at ${width}`).toBeLessThanOrEqual(0);
      if (width === 390) await shot(page, "question-edit-phone-390");
      if (width === 320) {
        await page.goto(`/staff/${tenant.slug}/questions`);
        await shot(page, "questions-list-phone-320");
        await page.goto(`/staff/${tenant.slug}/questions/${ids.ceremony}`);
        await shot(page, "question-page-phone-320");
      }
      await page.context().close();
    }
  });
});
