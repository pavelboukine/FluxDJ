/**
 * Proposal templates in real browsers, in dedicated test businesses: the
 * list (empty, populated, search over name and intro across pages, archived
 * on request, Clear filters, pagination, URL state), the overview (packages
 * in order with prices and gear, the recommended one, questions with their
 * rules, extras, problems with fix links), archived packages, questions and
 * gear already used being kept and flagged (never dropped on save), adding
 * a template with its contents in one form (validation, a failed request and
 * a lost reply never leaving a partial or duplicate template), editing and
 * reordering, archive and restore, a sent proposal unchanged by template
 * edits, other businesses and suspended workspaces refused, and phone
 * layouts. E2E_SCREENSHOTS=1 keeps review screenshots in
 * review-samples/templates-questions (not cleared by later runs).
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const REVIEW = "review-samples/templates-questions";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page: Page, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(REVIEW, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: `${REVIEW}/${name}.png`, fullPage });
}

test.describe.serial("proposal templates", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let empty: TestTenant;
  let other: TestTenant;
  let suspended: TestTenant;
  const run = randomUUID().slice(0, 6);
  const ids: Record<string, string> = {};
  let createdId = "";

  const id = async (table: "packages" | "gear_items" | "logistics_questions" | "proposal_templates", column: string, value: string) =>
    (await must(admin.from(table).select("id").eq("tenant_id", tenant.id).eq(column, value).single())).data!.id as string;
  const composition = async (templateId: string) => {
    const [pk, q, a, t] = await Promise.all([
      must(admin.from("proposal_template_packages").select("package_id, sort_order").eq("template_id", templateId).order("sort_order")),
      must(admin.from("proposal_template_questions").select("question_id, sort_order").eq("template_id", templateId).order("sort_order")),
      must(admin.from("proposal_template_addons").select("gear_item_id, recommended_quantity, max_quantity, sort_order").eq("template_id", templateId).order("sort_order")),
      must(admin.from("proposal_templates").select("default_package_id, active").eq("id", templateId).single()),
    ]);
    return {
      packages: pk.data!.map((x) => x.package_id),
      questions: q.data!.map((x) => x.question_id),
      addons: a.data!.map((x) => [x.gear_item_id, x.recommended_quantity, x.max_quantity]),
      recommended: t.data!.default_package_id,
      active: t.data!.active,
    };
  };

  async function staffPage(t: TestTenant, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 1000 } }) {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, t.ownerEmail);
    return page;
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("templates", { catalog: true });
    empty = await createTestTenant("templates-empty");
    other = await createTestTenant("templates-other");
    suspended = await createTestTenant("templates-suspended", { catalog: true });
    for (const k of ["essential", "signature", "premium"]) ids[k] = await id("packages", "key", k);
    ids.wedding = await id("proposal_templates", "name", "Wedding (DEMO)");
    ids.ceremony = await id("logistics_questions", "key", "ceremony_location");
    ids.cocktail = await id("logistics_questions", "key", "cocktail_location");
    ids.speeches = await id("logistics_questions", "key", "speeches_wireless_mic");
    ids.uplights = await id("gear_items", "key", "uplights_4");
    // Fillers for pagination (26 active templates) and an archived one only its intro matches.
    await must(admin.from("proposal_templates").insert(Array.from({ length: 25 }, (_, i) => ({ tenant_id: tenant.id, name: `Filler ${String(i + 1).padStart(2, "0")}`, intro: "Generic intro" }))));
    await must(admin.from("proposal_templates").insert({ tenant_id: tenant.id, name: "Old corporate", intro: "Retired: 100%_off launch party", active: false }));
    // A template whose package, question and extra are archived.
    ids.oldPkg = randomUUID();
    ids.oldQ = randomUUID();
    ids.oldGear = randomUUID();
    ids.broken = randomUUID();
    await must(admin.from("packages").insert({ id: ids.oldPkg, tenant_id: tenant.id, key: "old_bundle", name: "Old bundle", base_price_cents: 99_000, active: false }));
    await must(admin.from("logistics_questions").insert({ id: ids.oldQ, tenant_id: tenant.id, key: "old_question", prompt: "Old: dance floor size?", answer_type: "short_text", options: [], active: false }));
    await must(admin.from("gear_items").insert({ id: ids.oldGear, tenant_id: tenant.id, key: "old_fog", name: "Old fog machine", default_price_cents: 4_000, active: false }));
    await must(admin.from("proposal_templates").insert({ id: ids.broken, tenant_id: tenant.id, name: "Broken gala", intro: "Has archived parts" }));
    await must(
      admin.from("proposal_template_packages").insert([
        { tenant_id: tenant.id, template_id: ids.broken, package_id: ids.essential, sort_order: 1 },
        { tenant_id: tenant.id, template_id: ids.broken, package_id: ids.oldPkg, sort_order: 2 },
      ]),
    );
    await must(admin.from("proposal_template_questions").insert({ tenant_id: tenant.id, template_id: ids.broken, question_id: ids.oldQ, sort_order: 1 }));
    await must(admin.from("proposal_template_addons").insert({ tenant_id: tenant.id, template_id: ids.broken, gear_item_id: ids.oldGear, recommended_quantity: 0, max_quantity: 2, sort_order: 1 }));
  });

  test.afterAll(async () => {
    for (const t of [tenant, empty, other, suspended]) await archiveTestTenant(t);
  });

  test("list: empty business, rows with packages and problems, search, archived, Clear filters, pages", async () => {
    const blank = await staffPage(empty);
    await blank.goto(`/staff/${empty.slug}/templates`);
    await expect(blank.getByTestId("templates-empty")).toContainText("No proposal templates yet.");
    await expect(blank.getByRole("main").getByRole("link", { name: "Add template" })).toHaveAttribute("href", `/staff/${empty.slug}/templates/new`);
    await shot(blank, "templates-list-empty", false);
    await blank.context().close();

    const page = await staffPage(tenant);
    const base = `/staff/${tenant.slug}/templates`;
    await page.goto(base);
    const rows = page.getByTestId("template-row");
    await expect(rows).toHaveCount(25);
    await expect(page.getByTestId("list-result")).toContainText("27 active templates, by name. Showing 1–25 of 27. 1 archived template also matches.");
    const broken = rows.filter({ hasText: "Broken gala" });
    await expect(broken.getByTestId("template-packages-summary")).toContainText("Essential · Old bundle · 1 question");
    await expect(broken.getByTestId("template-flags")).toHaveText("Needs attention: 2 of 3 packages, no recommended package, archived package, archived question, archived extra");
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2$/);
    const wedding = rows.filter({ hasText: "Wedding (DEMO)" });
    await expect(wedding.getByTestId("template-packages-summary")).toHaveText("Essential · Signature (recommended) · Premium · 4 questions");
    await expect(wedding.getByTestId("template-flags")).toHaveCount(0);
    await shot(page, "templates-list-desktop");

    // Search covers the intro; % and _ are literal; archived on request.
    await page.goto(`${base}?q=${encodeURIComponent("100%_off")}`);
    await expect(page.getByTestId("templates-no-results")).toContainText("No templates match this search. 1 archived template matches but is hidden.");
    await page.getByTestId("templates-no-results").getByRole("link", { name: "Include archived" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Archived");
    await page.goto(`${base}?q=${encodeURIComponent("100%x")}&archived=1`);
    await expect(page.getByTestId("templates-no-results")).toBeVisible();
    // Clear filters resets results and controls.
    await page.goto(`${base}?q=filler&archived=1`);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(page.getByLabel("Include archived")).not.toBeChecked();
    await expect(rows).toHaveCount(25);
    // State survives a visit and Back.
    await page.getByLabel("Search").fill("wedding");
    await page.getByRole("button", { name: "Search" }).click();
    await rows.first().getByRole("link", { name: "Wedding (DEMO)" }).click();
    await expect(page.getByRole("heading", { name: "Wedding (DEMO)", level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Search")).toHaveValue("wedding");
    await page.context().close();
  });

  test("overview: packages in order with prices and gear, recommended, questions with readable rules", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/templates/${ids.wedding}`);
    const pkgs = page.getByTestId("template-package");
    await expect(pkgs).toHaveCount(3);
    await expect(pkgs.nth(0)).toContainText("Essential");
    await expect(pkgs.nth(0)).toContainText("$1,500.00");
    await expect(pkgs.nth(0)).toContainText("Includes Main reception sound system, Wireless microphone");
    await expect(pkgs.nth(1)).toContainText("Recommended");
    await expect(pkgs.nth(1).getByRole("link", { name: "Signature" })).toHaveAttribute("href", `/staff/${tenant.slug}/packages/${ids.signature}`);
    const qs = page.getByTestId("template-question");
    await expect(qs).toHaveCount(4);
    await expect(qs.nth(0)).toContainText("1. DEMO: Where will the ceremony take place?");
    await expect(qs.nth(0)).toContainText("One choice · Required");
    await expect(qs.nth(0)).toContainText("When “DEMO: Where will the ceremony take place?” is “A separate space”, require 1 × Additional-location speaker.");
    await expect(qs.nth(2)).toContainText("is Yes, require 1 × Wireless microphone.");
    await expect(qs.nth(3)).toContainText("No rules");
    await expect(page.getByText("quantities add up for each item")).toBeVisible();
    await expect(page.getByTestId("template-extras")).toContainText("Uplights (pack of 4)");
    await expect(page.getByTestId("template-extras")).toContainText("1 preselected");
    await expect(page.getByTestId("template-problems")).toHaveCount(0);
    await shot(page, "template-overview-desktop");
    await page.context().close();
  });

  test("archived packages, questions and gear stay, flagged with fixes, and saving keeps them", async () => {
    const page = await staffPage(tenant);
    const before = await composition(ids.broken);
    await page.goto(`/staff/${tenant.slug}/templates/${ids.broken}`);
    const problems = page.getByTestId("template-problems");
    await expect(problems).toContainText("It offers 2 of the 3 packages a proposal needs.");
    await expect(problems).toContainText("No recommended package");
    await expect(problems).toContainText("The package Old bundle is archived.");
    await expect(problems.getByRole("link", { name: "Restore it or choose another" })).toHaveAttribute("href", `/staff/${tenant.slug}/packages/${ids.oldPkg}`);
    await expect(problems).toContainText("The question “Old: dance floor size?” is archived.");
    await expect(problems).toContainText("The extra Old fog machine is archived gear.");
    await shot(page, "template-problems");

    // "Choose packages" opens the contents editor, with the archived items kept and explained.
    await problems.getByRole("link", { name: "Choose packages" }).click();
    await expect(page.getByLabel("Package 2", { exact: true })).toHaveValue(ids.oldPkg);
    await expect(page.getByTestId("package-slot").nth(1)).toContainText("Archived package");
    await expect(page.getByTestId("question-row")).toContainText("Archived question");
    await expect(page.getByTestId("addon-row")).toContainText("Archived gear");
    // Archived packages can't be chosen anew.
    await expect(page.getByLabel("Package 3", { exact: true }).locator("option", { hasText: "Old bundle" })).toHaveCount(0);
    await shot(page, "template-edit-archived", false);
    await page.getByRole("button", { name: "Save contents" }).click();
    await expect(page.locator("#contents").getByRole("status").filter({ hasText: "Contents saved." })).toBeVisible();
    expect(await composition(ids.broken)).toEqual(before);
    await page.context().close();
  });

  test("add a template: contents in one form, validation, and failed or lost saves never partial or duplicated", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/templates`);
    await page.getByRole("main").getByRole("link", { name: "Add template" }).click();
    await expect(page).toHaveURL(/\/templates\/new$/);
    const name = `E2E Corporate ${run}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Intro shown to clients (optional)").fill("Thanks for considering us.");
    await page.getByLabel("Package 1", { exact: true }).selectOption(ids.premium);
    await page.getByLabel("Package 2", { exact: true }).selectOption(ids.essential);
    // Each package once: a chosen one isn't offered in the other slots.
    await expect(page.getByLabel("Package 3", { exact: true }).locator(`option[value="${ids.premium}"]`)).toHaveCount(0);
    await page.getByLabel("Package 3", { exact: true }).selectOption(ids.signature);
    await expect(page.getByTestId("slot-summary").nth(0)).toContainText("$3,000.00");
    await expect(page.getByTestId("slot-summary").nth(0)).toContainText("Includes 2 × Additional-location speaker");
    // Put Essential first.
    await page.getByRole("button", { name: "Move package 2 earlier" }).click();
    await expect(page.getByLabel("Package 1", { exact: true })).toHaveValue(ids.essential);
    await page.getByRole("radio", { name: "Signature" }).check();
    await page.getByRole("button", { name: "Add DEMO: Will there be speeches that need a wireless microphone?" }).click();
    await page.getByRole("button", { name: "Add DEMO: Where will the ceremony take place?" }).click();
    await page.getByRole("button", { name: "Move “DEMO: Where will the ceremony take place?” earlier" }).click();
    await expect(page.getByTestId("question-row").nth(0)).toContainText("Where will the ceremony");
    await page.getByRole("button", { name: "Add Uplights (pack of 4)" }).click();
    await page.getByLabel("Maximum quantity of Uplights (pack of 4)").fill("2");
    await page.getByLabel("Preselected quantity of Uplights (pack of 4)").fill("3");
    await expect(page.getByTestId("addon-row").getByRole("alert")).toContainText("Preselected can't be more than the maximum.");
    await page.getByLabel("Preselected quantity of Uplights (pack of 4)").evaluate((el: HTMLInputElement) => el.removeAttribute("max"));
    await page.getByRole("button", { name: "Save template" }).click();
    const alert = page.getByRole("main").getByRole("alert").filter({ hasText: "Extras:" });
    await expect(alert).toContainText("“Preselected” from 0 to that maximum");
    await expect(page.getByLabel("Name")).toHaveValue(name);
    await expect(page.getByTestId("question-row")).toHaveCount(2);
    await shot(page, "template-new-error");
    await page.getByLabel("Preselected quantity of Uplights (pack of 4)").fill("1");

    // A request that never arrives keeps everything.
    await page.route("**/templates/new", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()), { times: 1 });
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "didn't go through" })).toBeVisible();
    await expect(page.getByTestId("question-row")).toHaveCount(2);
    expect((await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", name))).data).toHaveLength(0);

    // The server saves but the reply is lost; the retry returns that template.
    let dropped = false;
    await page.route("**/templates/new", async (route) => {
      if (route.request().method() === "POST" && !dropped) {
        dropped = true;
        await route.fetch().catch(() => null);
        return route.abort();
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "didn't go through" })).toBeVisible();
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("This template was already saved")).toBeVisible();
    const saved = (await must(admin.from("proposal_templates").select("id, intro, expiry_days").eq("tenant_id", tenant.id).eq("name", name))).data!;
    expect(saved).toHaveLength(1);
    createdId = saved[0].id;
    expect(saved[0]).toMatchObject({ intro: "Thanks for considering us.", expiry_days: 14 });
    expect(await composition(createdId)).toEqual({
      packages: [ids.essential, ids.premium, ids.signature],
      questions: [ids.ceremony, ids.speeches],
      addons: [[ids.uplights, 1, 2]],
      recommended: ids.signature,
      active: true,
    });
    await page.unroute("**/templates/new");
    await page.context().close();
  });

  test("edit contents: reorder, change the recommendation, remove a question; Cancel asks first", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/templates/${createdId}`);
    await page.getByRole("button", { name: "Edit packages, questions and extras" }).click();
    await page.getByRole("button", { name: "Move package 3 earlier" }).click();
    await page.getByRole("radio", { name: "Premium" }).check();
    await page.getByRole("button", { name: "Remove “DEMO: Will there be speeches that need a wireless microphone?”" }).click();
    await expect(page.locator("#contents")).toContainText("Unsaved changes");
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("question-row")).toHaveCount(1);
    // Removing the recommended package from the slots clears the recommendation.
    await page.getByLabel("Package 3", { exact: true }).selectOption("");
    await expect(page.getByRole("radio", { name: "None yet" })).toBeChecked();
    await page.getByLabel("Package 3", { exact: true }).selectOption(ids.premium);
    await page.getByRole("radio", { name: "Premium" }).check();
    await page.getByRole("button", { name: "Save contents" }).click();
    await expect(page.locator("#contents").getByRole("status").filter({ hasText: "Contents saved." })).toBeVisible();
    const after = await composition(createdId);
    expect(after.packages).toEqual([ids.essential, ids.signature, ids.premium]);
    expect(after.recommended).toBe(ids.premium);
    expect(after.questions).toEqual([ids.ceremony]);
    await expect(page.getByTestId("template-package").nth(2)).toContainText("Recommended");

    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Proposal expiry (days)").fill("400");
    await page.getByLabel("Proposal expiry (days)").evaluate((el: HTMLInputElement) => el.removeAttribute("max"));
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Proposals must expire after 1 to 365 days.");
    await page.getByLabel("Proposal expiry (days)").fill("30");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("status").filter({ hasText: "Details saved." })).toBeVisible();
    expect((await composition(createdId)).active).toBe(true);
    await page.context().close();
  });

  test("a sent proposal keeps its copy after template edits; archive and restore", async () => {
    const page = await staffPage(tenant);
    const clientId = randomUUID();
    const eventId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Template Client", email: `e2e-template-client-${run}@example.test` }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: "Template wedding", event_type: "wedding", event_date: "2027-10-02", venue_name: "E2E Hall" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const proposalUrl = await sendProposalFromEventPage(page, tenant, eventId);
    const proposalId = proposalUrl.split("/").pop()!;
    const frozen = async () => (await must(admin.from("proposals").select("offer_snapshot, offer_sha256").eq("id", proposalId).single())).data!;
    const before = await frozen();

    await page.goto(`/staff/${tenant.slug}/templates/${ids.wedding}`);
    await page.getByRole("button", { name: "Edit packages, questions and extras" }).click();
    await page.getByRole("radio", { name: "Premium" }).check();
    await page.getByRole("button", { name: "Remove “DEMO: Where will cocktail hour take place?”" }).click();
    await page.getByRole("button", { name: "Save contents" }).click();
    await expect(page.locator("#contents").getByRole("status").filter({ hasText: "Contents saved." })).toBeVisible();
    expect(await frozen()).toEqual(before);

    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the template" });
    await expect(dialog).toContainText("no longer offered under “Start from template”");
    await expect(dialog).toContainText("Sent proposals don't change.");
    await shot(page, "template-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive template" }).click();
    await expect(page.getByText("This template is archived.")).toBeVisible();
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await expect(page.locator("select option", { hasText: "Wedding (DEMO)" })).toHaveCount(0);
    await page.goto(`/staff/${tenant.slug}/templates/${ids.wedding}`);
    await page.getByRole("button", { name: "Restore template" }).click();
    await expect(page.getByText("Template restored.")).toBeVisible();
    expect(await frozen()).toEqual(before);
    await page.context().close();
  });

  test("another business and a suspended workspace are refused", async () => {
    const outsider = await staffPage(other);
    expect((await outsider.goto(`/staff/${tenant.slug}/templates`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${other.slug}/templates/${ids.wedding}`))?.status()).toBe(404);
    await outsider.context().close();
    const page = await staffPage(suspended);
    await page.goto(`/staff/${suspended.slug}/templates`);
    await expect(page.getByTestId("template-row")).toHaveCount(1);
    suspendLocally(suspended.id);
    for (const path of ["templates", "templates/new"]) {
      await page.goto(`/staff/${suspended.slug}/${path}`);
      await expect(page).toHaveURL(/\/unavailable$/);
    }
    await page.context().close();
  });

  test("on a phone: list, overview and the editors fit without sideways scrolling", async () => {
    for (const width of [390, 320]) {
      const page = await staffPage(tenant, { ...PHONE, viewport: { width, height: 844 } });
      for (const path of ["templates", "templates?archived=1&page=2", `templates/${ids.wedding}`, `templates/${ids.broken}`, "templates/new"]) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await sideways(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      }
      await page.goto(`/staff/${tenant.slug}/templates/${ids.wedding}`);
      if (width === 390) await shot(page, "template-overview-phone-390");
      await page.getByRole("button", { name: "Edit packages, questions and extras" }).click();
      expect(await sideways(page), `editing contents at ${width}`).toBeLessThanOrEqual(0);
      if (width === 320) {
        await shot(page, "template-edit-phone-320");
        await page.goto(`/staff/${tenant.slug}/templates`);
        await shot(page, "templates-list-phone-320");
      }
      await page.context().close();
    }
  });
});
