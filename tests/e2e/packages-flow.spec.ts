/**
 * Packages in real browsers, in dedicated test businesses: the list (empty,
 * populated, search over name and description across pages, archived on
 * request, Clear filters resetting results and controls, pagination, URL
 * state), adding a package with its included gear in one form (exact
 * prices, tax validation, add/remove/quantities, errors and a failed
 * request keeping input), editing details and included gear, archived gear
 * already included, audited archive and restore with accurate impact, a
 * sent proposal and its gear photo unchanged by catalog edits, other
 * businesses and suspended workspaces refused, and phone layouts.
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";
import { opaqueJpeg } from "../support/logo-fixtures";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}

test.describe.serial("packages", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let empty: TestTenant;
  let other: TestTenant;
  let suspended: TestTenant;
  const run = randomUUID().slice(0, 6);
  let createdId = "";
  const ids: Record<string, string> = {};

  const packageId = async (key: string) => (await must(admin.from("packages").select("id").eq("tenant_id", tenant.id).eq("key", key).single())).data!.id as string;
  const gearId = async (key: string) => (await must(admin.from("gear_items").select("id").eq("tenant_id", tenant.id).eq("key", key).single())).data!.id as string;
  const items = async (id: string) =>
    (await must(admin.from("package_items").select("gear_item_id, quantity").eq("package_id", id).order("gear_item_id"))).data!;

  async function staffPage(t: TestTenant, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 1000 } }) {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, t.ownerEmail);
    return page;
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("packages", { catalog: true });
    empty = await createTestTenant("packages-empty");
    other = await createTestTenant("packages-other");
    suspended = await createTestTenant("packages-suspended", { catalog: true });
    // Fillers for pagination (27 active packages) and for a searchable gear picker (11 active items).
    await must(
      admin.from("packages").insert(
        Array.from({ length: 24 }, (_, i) => ({ tenant_id: tenant.id, key: `filler_${i + 1}`, name: `Filler ${String(i + 1).padStart(2, "0")}`, base_price_cents: 10_000, sort_order: 10 + i })),
      ),
    );
    await must(admin.from("packages").insert({ tenant_id: tenant.id, key: "retired_gala", name: "Retired gala", description: "Old 100%_off bundle", base_price_cents: 90_000, sort_order: 50, active: false }));
    await must(
      admin.from("gear_items").insert(
        ["Fog machine", "Bubble machine", "Cold sparks", "Photo booth", "Tube lights", "Moving heads"].map((name, i) => ({
          tenant_id: tenant.id, key: `extra_${i}`, name, default_price_cents: 5_000 + i * 1_000, unit_label: "unit",
        })),
      ),
    );
    // Archived gear already included in a package.
    ids.strobe = randomUUID();
    ids.retro = randomUUID();
    await must(admin.from("gear_items").insert({ id: ids.strobe, tenant_id: tenant.id, key: "old_strobe", name: "Old strobe", default_price_cents: 3_000, unit_label: "light", active: false }));
    await must(admin.from("packages").insert({ id: ids.retro, tenant_id: tenant.id, key: "retro", name: "Retro night", base_price_cents: 80_000, sort_order: 40 }));
    await must(admin.from("package_items").insert({ tenant_id: tenant.id, package_id: ids.retro, gear_item_id: ids.strobe, quantity: 2 }));
  });

  test.afterAll(async () => {
    for (const t of [tenant, empty, other, suspended]) await archiveTestTenant(t);
  });

  test("list: empty business, rows with price and gear, search, archived, Clear filters, pages", async ({}, info) => {
    const blank = await staffPage(empty);
    await blank.goto(`/staff/${empty.slug}/packages`);
    await expect(blank.getByTestId("packages-empty")).toContainText("No packages yet.");
    await expect(blank.getByRole("main").getByRole("link", { name: "Add package" })).toHaveAttribute("href", `/staff/${empty.slug}/packages/new`);
    await shot(blank, info, "packages-list-empty", false);
    await blank.context().close();

    const page = await staffPage(tenant);
    const base = `/staff/${tenant.slug}/packages`;
    await page.goto(base);
    const rows = page.getByTestId("package-row");
    await expect(rows).toHaveCount(25);
    await expect(page.getByTestId("list-result")).toContainText("28 active packages, in display order. Showing 1–25 of 28. 1 archived package also matches.");
    const signature = rows.filter({ hasText: "Signature" });
    await expect(signature.getByTestId("package-price")).toContainText("$2,200.00");
    await expect(signature.getByTestId("package-price")).toContainText("base price, before tax");
    await expect(signature.getByTestId("package-gear")).toHaveText("Includes Additional-location speaker, Dance floor lighting, Main reception sound system +1 more");
    await expect(signature).toContainText("DEMO: adds dance floor lighting");
    await shot(page, info, "packages-list-desktop");
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/page=2$/);
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Retro night" }).getByTestId("package-gear")).toContainText("Includes 2 × Old strobe · 1 archived gear item");

    // Search covers descriptions over every page; % and _ are literal; archived on request.
    await page.goto(`${base}?q=uplighting`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Premium");
    await page.goto(`${base}?q=${encodeURIComponent("100%_off")}`);
    await expect(page.getByTestId("packages-no-results")).toContainText("No packages match this search. 1 archived package matches but is hidden.");
    await page.getByTestId("packages-no-results").getByRole("link", { name: "Include archived" }).click();
    await expect(page).toHaveURL(/q=100%25_off&archived=1$/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Archived");
    await page.goto(`${base}?q=${encodeURIComponent("100%x")}&archived=1`);
    await expect(page.getByTestId("packages-no-results")).toBeVisible();

    // Clear filters resets the results and the visible controls.
    await page.goto(`${base}?q=filler&archived=1&page=1`);
    await expect(page.getByLabel("Include archived")).toBeChecked();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(page.getByLabel("Include archived")).not.toBeChecked();
    await expect(rows).toHaveCount(25);

    // State survives a visit to a package and Back.
    await page.getByLabel("Search").fill("premium");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=premium$/);
    await rows.first().getByRole("link", { name: "Premium" }).click();
    await expect(page.getByRole("heading", { name: "Premium", level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Search")).toHaveValue("premium");
    await expect(rows).toHaveCount(1);
    await page.context().close();
  });

  test("details: price explained, included gear with thumbnails and links, archived gear flagged, Used in", async ({}, info) => {
    // A photo on the uplights, so the premium package shows a thumbnail.
    const uplights = await gearId("uplights_4");
    const path = `${tenant.id}/gear-items/${uplights}/${randomUUID()}.jpg`;
    await must(admin.storage.from("gear-media").upload(path, await opaqueJpeg(300, 200), { contentType: "image/jpeg" }));
    await must(admin.from("gear_media").insert({ tenant_id: tenant.id, gear_item_id: uplights, storage_path: path, kind: "image", content_type: "image/jpeg", alt_text: "Four uplights glowing teal" }));

    const page = await staffPage(tenant);
    const premium = await packageId("premium");
    await page.goto(`/staff/${tenant.slug}/packages/${premium}`);
    await expect(page.locator("[data-slot=badge]", { hasText: "Active" })).toBeVisible();
    await expect(page.getByTestId("package-price")).toHaveText("$3,000.00");
    await expect(page.locator("#details")).toContainText("Its included gear is part of it and never charged separately.");
    const list = page.getByTestId("included-item");
    await expect(list).toHaveCount(5);
    const up = list.filter({ hasText: "Uplights (pack of 4)" });
    await expect(up).toContainText("× 2");
    await expect(up.locator("img")).toBeVisible();
    await expect(up.getByRole("link", { name: "Uplights (pack of 4)" })).toHaveAttribute("href", `/staff/${tenant.slug}/gear/${uplights}`);
    await expect(page.getByTestId("package-uses").getByRole("link", { name: "Wedding (DEMO)" })).toBeVisible();
    await expect(page.getByTestId("package-uses")).toContainText("package 3");
    // The key and secondary settings are present but quiet; no edit form until asked.
    await expect(page.getByLabel("Name")).toBeHidden();
    await shot(page, info, "package-detail-desktop");

    await page.goto(`/staff/${tenant.slug}/packages/${ids.retro}`);
    await expect(page.getByTestId("archived-gear-warning")).toContainText("1 included item is archived gear. Proposals with this package can't be previewed or sent");
    await expect(page.getByTestId("included-item")).toContainText("Archived gear");
    await expect(page.getByTestId("package-uses")).toHaveCount(0);
    await expect(page.getByText("Not offered by any proposal template yet.")).toBeVisible();
    // Editing keeps the archived gear (explained), and it can't be added back once removed.
    await page.getByRole("button", { name: "Edit included gear" }).click();
    const row = page.getByTestId("included-row");
    await expect(row).toContainText("Archived gear");
    await expect(row).toContainText("Remove it here, or restore the gear item.");
    await expect(page.getByLabel("Quantity of Old strobe")).toHaveValue("2");
    await expect(page.getByRole("button", { name: "Add Old strobe" })).toHaveCount(0);
    await shot(page, info, "package-edit-gear-archived", false);
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await items(ids.retro)).toEqual([{ gear_item_id: ids.strobe, quantity: 2 }]);
    await page.context().close();
  });

  test("add a package: details and gear in one form, exact price, errors and a failed request keep everything", async ({}, info) => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages`);
    await page.getByRole("main").getByRole("link", { name: "Add package" }).click();
    await expect(page).toHaveURL(/\/packages\/new$/);
    await expect(page.getByText("All fields are required unless marked optional.")).toBeVisible();
    await expect(page.getByLabel("Tax category")).toHaveValue("standard");

    const name = `E2E Gold ${run}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Description (optional)").fill("Ceremony, cocktails and reception.");
    await page.getByLabel("Base price (CAD)").fill("2,499.995");

    // The picker is searchable (11 active items); Enter adds the first match.
    await page.getByLabel("Find gear to add").fill("moving");
    await expect(page.getByRole("button", { name: /^Add / })).toHaveCount(1);
    await page.getByLabel("Find gear to add").press("Enter");
    await expect(page.getByLabel("Quantity of Moving heads")).toBeFocused();
    await page.getByLabel("Quantity of Moving heads").fill("2");
    await page.getByLabel("Find gear to add").fill("wireless");
    await page.getByRole("button", { name: "Add Wireless microphone" }).click();
    await page.getByLabel("Find gear to add").fill("fog");
    await page.getByRole("button", { name: "Add Fog machine" }).click();
    // Each item once: an added item leaves the choices.
    await page.getByLabel("Find gear to add").fill("fog");
    await expect(page.getByRole("button", { name: "Add Fog machine" })).toHaveCount(0);
    await expect(page.getByText("No gear matches “fog”.")).toBeVisible();
    await page.getByRole("button", { name: "Remove Fog machine" }).click();
    await expect(page.getByTestId("included-row")).toHaveCount(2);
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    // A server-side price error keeps every field and the chosen gear.
    await page.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Enter a base price like 1500 or 1500.00.");
    await expect(page.getByLabel("Name")).toHaveValue(name);
    await expect(page.getByLabel("Quantity of Moving heads")).toHaveValue("2");
    await expect(page.getByTestId("included-row")).toHaveCount(2);
    await shot(page, info, "package-new-error");

    // An unconfigured tax category is refused by the server.
    await page.getByLabel("Tax category").evaluate((el: HTMLSelectElement) => {
      el.add(new Option("made_up", "made_up"));
      el.value = "made_up";
    });
    await page.getByLabel("Base price (CAD)").fill("2,499.99");
    await page.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Choose a configured tax category.");
    await page.getByLabel("Tax category").selectOption("standard");

    // A request that never reaches the server keeps everything, with an error.
    await page.route(`**/packages/new`, (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
    await page.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("The save didn't go through.");
    await expect(page.getByLabel("Name")).toHaveValue(name);
    await expect(page.getByTestId("included-row")).toHaveCount(2);
    await page.unroute(`**/packages/new`);
    expect((await must(admin.from("packages").select("id").eq("tenant_id", tenant.id).eq("name", name))).data).toHaveLength(0);

    // Cancel with typed values asks; declining stays.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/packages\/new$/);

    await page.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByText("Package created.")).toBeVisible();
    createdId = /\/packages\/([0-9a-f-]{36})\?created=1$/.exec(page.url())![1];
    const row = (await must(admin.from("packages").select("name, base_price_cents, tax_category, active, sort_order, is_popular").eq("id", createdId).single())).data!;
    expect(row).toEqual({ name, base_price_cents: 249_999, tax_category: "standard", active: true, sort_order: 0, is_popular: false });
    const [heads, mic] = [await gearId("extra_5"), await gearId("wireless_mic")];
    expect(await items(createdId)).toEqual([{ gear_item_id: heads, quantity: 2 }, { gear_item_id: mic, quantity: 1 }].sort((a, b) => a.gear_item_id.localeCompare(b.gear_item_id)));
    await expect(page.getByTestId("included-item")).toHaveCount(2);
    await expect(page.getByTestId("package-price")).toHaveText("$2,499.99");
    await shot(page, info, "package-created");
    await page.context().close();
  });

  test("edit details and included gear: quantities, add, remove; archiving is never a side effect", async ({}, info) => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/${createdId}`);
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(page.locator("#details").getByLabel(/Active/)).toHaveCount(0);
    await page.getByLabel("Base price (CAD)").fill("abc");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Enter a base price like 1500 or 1500.00.");
    await page.getByLabel("Base price (CAD)").fill("$1,800.5");
    await page.getByLabel("Display order").fill("7");
    await shot(page, info, "package-edit-details", false);
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("status").filter({ hasText: "Package saved." })).toBeVisible();
    await expect(page.getByTestId("package-price")).toHaveText("$1,800.50");
    expect((await must(admin.from("packages").select("base_price_cents, sort_order, active").eq("id", createdId).single())).data).toEqual({ base_price_cents: 180_050, sort_order: 7, active: true });

    await page.getByRole("button", { name: "Edit included gear" }).click();
    await page.getByLabel("Quantity of Moving heads").fill("101");
    await page.getByLabel("Quantity of Moving heads").evaluate((el: HTMLInputElement) => el.removeAttribute("max"));
    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.locator("#included").getByRole("alert")).toContainText("Quantities must be whole numbers from 1 to 100.");
    await page.getByLabel("Quantity of Moving heads").fill("4");
    await page.getByRole("button", { name: "Remove Wireless microphone" }).click();
    await page.getByLabel("Find gear to add").fill("tube");
    await page.getByRole("button", { name: "Add Tube lights" }).click();
    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.locator("#included").getByRole("status").filter({ hasText: "Included gear saved." })).toBeVisible();
    await expect(page.getByTestId("included-item")).toHaveCount(2);
    const [heads, tubes] = [await gearId("extra_5"), await gearId("extra_4")];
    expect(await items(createdId)).toEqual([{ gear_item_id: heads, quantity: 4 }, { gear_item_id: tubes, quantity: 1 }].sort((a, b) => a.gear_item_id.localeCompare(b.gear_item_id)));
    expect((await must(admin.from("packages").select("active").eq("id", createdId).single())).data!.active).toBe(true);
    await page.context().close();
  });

  test("a failed or lost save never leaves a partial or duplicate package; the choices are kept for retry", async ({}, info) => {
    // Another business's gear: the database refuses it, so the save fails after validation.
    const foreign = randomUUID();
    await must(admin.from("gear_items").insert({ id: foreign, tenant_id: other.id, key: `foreign_${run}`, name: "Foreign speaker", default_price_cents: 1_000 }));
    const inject = (page: Page, button: string) =>
      page.locator("form", { has: page.getByRole("button", { name: button }) }).evaluate((f, id) => {
        const i = document.createElement("input");
        Object.assign(i, { type: "hidden", name: `qty:${id}`, value: "1", id: "injected" });
        f.appendChild(i);
      }, foreign);
    const named = async (...names: string[]) => (await must(admin.from("packages").select("id, name").eq("tenant_id", tenant.id).in("name", names))).data!;

    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/new`);
    const name = `E2E Partial ${run}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Base price (CAD)").fill("1,234.56");
    await page.getByLabel("Find gear to add").fill("wireless");
    await page.getByRole("button", { name: "Add Wireless microphone" }).click();
    await page.getByLabel("Quantity of Wireless microphone").fill("3");
    await inject(page, "Save package");
    await page.getByRole("button", { name: "Save package" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Nothing was saved.");
    await expect(page).toHaveURL(/\/packages\/new$/);
    await expect(page.getByLabel("Name")).toHaveValue(name);
    await expect(page.getByLabel("Quantity of Wireless microphone")).toHaveValue("3");
    await expect(page.getByTestId("included-row")).toHaveCount(1);
    expect(await named(name)).toHaveLength(0);
    await shot(page, info, "package-new-nothing-saved", false);

    // The server saves but the reply is lost; a retry (even with an edited name) returns that package.
    await page.locator("#injected").evaluate((el) => el.remove());
    let dropped = false;
    await page.route("**/packages/new", async (route) => {
      if (route.request().method() === "POST" && !dropped) {
        dropped = true;
        await route.fetch().catch(() => null);
        return route.abort();
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Save package" }).click();
    await expect(alert).toContainText("The save didn't go through.");
    await expect(page.getByTestId("included-row")).toHaveCount(1);
    const saved = await named(name);
    expect(saved).toHaveLength(1);
    await page.getByLabel("Name").fill(`${name} renamed`);
    await page.getByRole("button", { name: "Save package" }).click();
    await page.waitForURL(new RegExp(`/packages/${saved[0].id}\\?created=replayed$`));
    await expect(page.getByText("This package was already saved")).toBeVisible();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    expect(await named(name, `${name} renamed`)).toHaveLength(1);
    const mic = await gearId("wireless_mic");
    expect(await items(saved[0].id)).toEqual([{ gear_item_id: mic, quantity: 3 }]);
    await shot(page, info, "package-replayed", false);
    await page.unroute("**/packages/new");

    // Editing included gear is one database call: a refused item changes nothing.
    await page.getByRole("button", { name: "Edit included gear" }).click();
    await page.getByLabel("Quantity of Wireless microphone").fill("5");
    await inject(page, "Save included gear");
    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.locator("#included").getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Quantity of Wireless microphone")).toHaveValue("5");
    expect(await items(saved[0].id)).toEqual([{ gear_item_id: mic, quantity: 3 }]);
    await page.context().close();
  });

  test("the package's own most-popular flag is not shown and saving details keeps it", async () => {
    const essential = await packageId("essential");
    await must(admin.from("packages").update({ is_popular: true }).eq("id", essential));
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/${essential}`);
    await expect(page.getByRole("main")).not.toContainText(/most popular/i);
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel(/most popular/i)).toHaveCount(0);
    await page.getByLabel("Description (optional)").fill("DEMO: reception DJ, main sound, one mic.");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("status").filter({ hasText: "Package saved." })).toBeVisible();
    expect((await must(admin.from("packages").select("is_popular, description").eq("id", essential).single())).data).toEqual({ is_popular: true, description: "DEMO: reception DJ, main sound, one mic." });
    await page.goto(`/staff/${tenant.slug}/packages/new`);
    await expect(page.getByLabel(/most popular/i)).toHaveCount(0);
    // Proposal templates keep their own recommended package.
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    await page.goto(`/staff/${tenant.slug}/templates/${template!.id}`);
    await expect(page.getByLabel("Recommended (most popular) package")).toBeVisible();
    await page.context().close();
  });

  test("a sent proposal keeps its packages and gear photo after catalog changes", async () => {
    const page = await staffPage(tenant);
    const clientId = randomUUID();
    const eventId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Package Client", email: `e2e-package-client-${run}@example.test` }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: "Package wedding", event_type: "wedding", event_date: "2027-09-25", venue_name: "E2E Hall" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const proposalUrl = await sendProposalFromEventPage(page, tenant, eventId);
    const proposalId = proposalUrl.split("/").pop()!;
    const frozen = async () => (await must(admin.from("proposals").select("offer_snapshot, offer_sha256").eq("id", proposalId).single())).data!;
    const before = await frozen();
    const premiumCopy = (before.offer_snapshot as { packages: { key: string; base_price_cents: number; included: { gear_key: string; quantity: number }[] }[] }).packages.find((p) => p.key === "premium")!;
    expect(premiumCopy.base_price_cents).toBe(300_000);
    expect(premiumCopy.included).toContainEqual({ gear_key: "uplights_4", quantity: 2 });

    // Change Premium: price, and the uplights removed.
    const premium = await packageId("premium");
    await page.goto(`/staff/${tenant.slug}/packages/${premium}`);
    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Base price (CAD)").fill("3,250");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("status").filter({ hasText: "Package saved." })).toBeVisible();
    await page.getByRole("button", { name: "Edit included gear" }).click();
    await page.getByRole("button", { name: "Remove Uplights (pack of 4)" }).click();
    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.locator("#included").getByRole("status").filter({ hasText: "Included gear saved." })).toBeVisible();

    expect(await frozen()).toEqual(before);
    await page.goto(proposalUrl);
    const photo = page.getByRole("img", { name: "Four uplights glowing teal" }).first();
    await expect(photo).toBeVisible();
    expect(await photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.context().close();
  });

  test("archive: confirmation with the real impact, audited, restore; templates keep it", async ({}, info) => {
    const page = await staffPage(tenant);
    const signature = await packageId("signature");
    await page.goto(`/staff/${tenant.slug}/packages/${signature}`);
    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the package" });
    await expect(dialog).toContainText("can't be chosen for templates or proposal drafts");
    await expect(dialog).toContainText("1 proposal template still offers it");
    await expect(dialog).toContainText("can't be previewed or sent until you choose another package or restore it");
    await expect(dialog).toContainText("Proposals already sent keep their own copy of the package.");
    await shot(page, info, "package-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive package" }).click();
    await expect(page.getByText("This package is archived.")).toBeVisible();
    await expect(page.locator("[data-slot=badge]", { hasText: "Archived" }).first()).toBeVisible();
    expect((await must(admin.from("packages").select("active").eq("id", signature).single())).data!.active).toBe(false);
    expect((await must(admin.from("proposal_template_packages").select("id").eq("package_id", signature))).data).toHaveLength(1);
    expect((await must(admin.from("package_items").select("id").eq("package_id", signature))).data!.length).toBeGreaterThan(0);

    await page.goto(`/staff/${tenant.slug}/packages`);
    await expect(page.getByTestId("package-list")).not.toContainText("Signature");
    await page.goto(`/staff/${tenant.slug}/packages/${signature}`);
    await page.getByRole("button", { name: "Restore package" }).click();
    await expect(page.getByText("Package restored.")).toBeVisible();
    expect((await must(admin.from("packages").select("active").eq("id", signature).single())).data!.active).toBe(true);
    const audit = (await must(admin.from("audit_events").select("action, actor_type").eq("entity_type", "package").eq("entity_id", signature).order("occurred_at"))).data;
    expect(audit).toEqual([{ action: "package_archived", actor_type: "staff" }, { action: "package_restored", actor_type: "staff" }]);
    await page.context().close();
  });

  test("another business and a suspended workspace are refused", async () => {
    const outsider = await staffPage(other);
    expect((await outsider.goto(`/staff/${tenant.slug}/packages`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${tenant.slug}/packages/${createdId}`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${other.slug}/packages/${createdId}`))?.status()).toBe(404);
    await outsider.context().close();

    const page = await staffPage(suspended);
    await page.goto(`/staff/${suspended.slug}/packages`);
    await expect(page.getByTestId("package-row")).toHaveCount(3);
    suspendLocally(suspended.id);
    for (const path of ["packages", "packages/new"]) {
      await page.goto(`/staff/${suspended.slug}/${path}`);
      await expect(page).toHaveURL(/\/unavailable$/);
    }
    await page.context().close();
  });

  test("on a phone: list, details and the form fit without sideways scrolling", async ({}, info) => {
    for (const width of [390, 320]) {
      const page = await staffPage(tenant, { ...PHONE, viewport: { width, height: 844 } });
      const premium = await packageId("premium");
      for (const path of ["packages", "packages?archived=1&page=2", `packages/${premium}`, `packages/${ids.retro}`, "packages/new"]) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await sideways(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      }
      await page.goto(`/staff/${tenant.slug}/packages/${createdId}`);
      await page.getByRole("button", { name: "Edit included gear" }).click();
      expect(await sideways(page), `editing gear at ${width}`).toBeLessThanOrEqual(0);
      if (width === 390) await shot(page, info, "package-edit-gear-phone");
      if (width === 320) {
        await page.goto(`/staff/${tenant.slug}/packages`);
        await shot(page, info, "packages-list-phone-320");
        await page.goto(`/staff/${tenant.slug}/packages/${premium}`);
        await shot(page, info, "package-detail-phone-320");
      }
      await page.context().close();
    }
  });
});
