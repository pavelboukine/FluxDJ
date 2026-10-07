/**
 * Gear management in real browsers, in dedicated test businesses: the list
 * (empty, populated, search over name and description, archived on request,
 * URL state), adding and editing an item (exact prices, tax validation and
 * missing-tax guidance, unsaved input), media (real image and video uploads,
 * a disguised file rejected, a failed upload leaving media intact, order and
 * archive), a sent proposal keeping its copy after catalog changes, archive
 * with its "Used in" warning, other businesses and suspended workspaces
 * refused, and phone layouts. Media are generated fixtures.
 * E2E_SCREENSHOTS=1 also keeps review screenshots.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { suspendLocally } from "../support/local-sql";
import { htmlDisguisedAsPng, opaqueJpeg, transparentPng } from "../support/logo-fixtures";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** An MP4 header ("ftyp isom"): enough for the content check; never played. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isommp41"), Buffer.alloc(4096, 0)]);

async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
}

test.describe.serial("gear catalog", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let empty: TestTenant;
  let noTax: TestTenant;
  let other: TestTenant;
  let suspended: TestTenant;
  const run = randomUUID().slice(0, 6);
  let createdId = "";

  const gearId = async (t: TestTenant, key: string) => (await must(admin.from("gear_items").select("id").eq("tenant_id", t.id).eq("key", key).single())).data!.id as string;
  const mediaRows = async (id: string) =>
    (await must(admin.from("gear_media").select("id, kind, alt_text, sort_order, active, storage_path").eq("gear_item_id", id).order("sort_order").order("created_at"))).data!;

  async function staffPage(t: TestTenant, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 1000 } }) {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, t.ownerEmail);
    return page;
  }

  async function upload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, alt: string) {
    await page.getByLabel("Photo or video", { exact: true }).setInputFiles(file);
    await page.getByLabel("Description (alt text)").fill(alt);
    await page.getByRole("button", { name: "Upload" }).click();
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("gear", { catalog: true });
    empty = await createTestTenant("gear-empty");
    noTax = await createTestTenant("gear-notax");
    other = await createTestTenant("gear-other");
    suspended = await createTestTenant("gear-suspended", { catalog: true });
    await must(admin.from("tenants").update({ tax_config: [], tax_categories: {} }).eq("id", noTax.id));
    // An archived item, with a description only it matches.
    await must(admin.from("gear_items").insert({ tenant_id: tenant.id, key: "old_fog", name: "Old fog machine", description: "Retired: 50% louder than allowed", default_price_cents: 4_000, unit_label: "machine", active: false }));
  });

  test.afterAll(async () => {
    for (const t of [tenant, empty, noTax, other, suspended]) await archiveTestTenant(t);
  });

  test("list: empty business, rows with prices and placeholders, search, archived, URL state", async ({}, info) => {
    const blank = await staffPage(empty);
    await blank.goto(`/staff/${empty.slug}/gear`);
    await expect(blank.getByTestId("gear-empty")).toContainText("No gear yet.");
    await expect(blank.getByRole("main").getByRole("link", { name: "Add gear" })).toHaveAttribute("href", `/staff/${empty.slug}/gear/new`);
    await shot(blank, info, "gear-list-empty", false);
    await blank.context().close();

    const page = await staffPage(tenant);
    const base = `/staff/${tenant.slug}/gear`;
    await page.goto(base);
    const rows = page.getByTestId("gear-row");
    await expect(rows).toHaveCount(5);
    await expect(page.getByTestId("list-result")).toContainText("5 active items, by name. 1 archived item also matches.");
    const uplights = rows.filter({ hasText: "Uplights (pack of 4)" });
    await expect(uplights).toContainText("DEMO: one unit is four colour-matched uplights.");
    await expect(uplights.getByTestId("gear-price")).toContainText("$120.00");
    await expect(uplights.getByTestId("gear-price")).toContainText("unit price, per pack");
    await expect(uplights.getByTestId("gear-no-photo")).toBeVisible();
    await expect(page.getByTestId("gear-list")).not.toContainText("Old fog machine");

    // Search covers the description, over every record; archived on request.
    await page.getByLabel("Search").fill("colour-matched");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}\\?q=colour-matched$`));
    await expect(rows).toHaveCount(1);
    await page.goto(`${base}?q=${encodeURIComponent("50%")}`);
    await expect(page.getByTestId("gear-no-results")).toContainText("No gear matches this search. 1 archived item matches but is hidden.");
    await page.getByTestId("gear-no-results").getByRole("link", { name: "Include archived" }).click();
    await expect(page).toHaveURL(/q=50%25&archived=1$/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Archived");
    await shot(page, info, "gear-list-archived-search");
    // A literal % and _ are not wildcards.
    await page.goto(`${base}?q=${encodeURIComponent("_")}&archived=1`);
    await expect(page.getByTestId("gear-no-results")).toBeVisible();
    // The earlier "Show archived" link still works.
    await page.goto(`${base}?show=archived`);
    await expect(rows).toHaveCount(6);
    await expect(page.getByLabel("Include archived")).toBeChecked();
    await page.getByLabel("Include archived").uncheck();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(rows).toHaveCount(5);

    // State survives a visit to an item and Back.
    await page.goto(`${base}?q=speaker`);
    await rows.first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("speaker");
    await page.goBack();
    await expect(page).toHaveURL(/q=speaker$/);
    await expect(page.getByLabel("Search")).toHaveValue("speaker");
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}$`));
    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(rows).toHaveCount(5);
    await shot(page, info, "gear-list-desktop");
    await page.context().close();
  });

  test("add gear: required fields, exact prices, errors keep input, then the item page", async ({}, info) => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/gear`);
    await page.getByRole("main").getByRole("link", { name: "Add gear" }).click();
    await expect(page).toHaveURL(/\/gear\/new$/);
    await expect(page.getByText("All fields are required unless marked optional.")).toBeVisible();
    await expect(page.getByLabel("Tax category")).toHaveValue("standard");
    await expect(page.getByText("Save the item first.")).toBeVisible();

    const name = `E2E Bubble machine ${run}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Description (optional)").fill("Bubbles for the first dance.");
    await page.getByLabel("Unit price (CAD)").fill("12.345");
    await page.getByLabel("Unit (optional)").fill("machine");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Enter a price like 150 or 150.00.");
    await expect(page.getByLabel("Name")).toHaveValue(name);
    await expect(page.getByLabel("Description (optional)")).toHaveValue("Bubbles for the first dance.");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await shot(page, info, "gear-new-error");

    // A tax category that isn't configured is refused by the server.
    await page.getByLabel("Tax category").evaluate((el: HTMLSelectElement) => {
      el.add(new Option("made_up", "made_up"));
      el.value = "made_up";
    });
    await page.getByLabel("Unit price (CAD)").fill("1,250.5");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Choose a configured tax category.");
    await page.getByLabel("Tax category").selectOption("standard");

    // Cancel with typed values asks; declining stays.
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/gear\/new$/);

    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Gear item created.")).toBeVisible();
    createdId = /\/gear\/([0-9a-f-]{36})\?created=1$/.exec(page.url())![1];
    const row = (await must(admin.from("gear_items").select("name, default_price_cents, unit_label, tax_category, active, key").eq("id", createdId).single())).data!;
    expect(row).toEqual({ name, default_price_cents: 125_050, unit_label: "machine", tax_category: "standard", active: true, key: `e2e_bubble_machine_${run}` });
    await expect(page.getByTestId("gear-price")).toHaveText("$1,250.50");
    await expect(page.getByTestId("gear-no-media")).toBeVisible();
    await expect(page.getByTestId("gear-uses")).toHaveCount(0);
    await expect(page.getByText("Not used in any package")).toBeVisible();
    await shot(page, info, "gear-page-no-media");

    // Edit details: the form is behind Edit, keeps errors' input, saves exact cents; archiving isn't in it.
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(page.getByLabel("Name")).toBeFocused();
    await expect(page.locator("#details").getByLabel(/Active/)).toHaveCount(0);
    await page.getByLabel("Unit price (CAD)").fill("abc");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator("#details").getByRole("alert")).toContainText("Enter a price like 150 or 150.00.");
    await page.getByLabel("Unit price (CAD)").fill("$0.10");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gear item saved." })).toBeVisible();
    await expect(page.getByTestId("gear-price")).toHaveText("$0.10");
    expect((await must(admin.from("gear_items").select("default_price_cents, active").eq("id", createdId).single())).data).toEqual({ default_price_cents: 10, active: true });
    await page.context().close();
  });

  test("a business without taxes: guidance and a Settings link, nothing invented", async ({}, info) => {
    const page = await staffPage(noTax);
    await page.goto(`/staff/${noTax.slug}/gear/new`);
    await expect(page.getByText("No taxes are set up yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open tax settings" })).toHaveAttribute("href", `/staff/${noTax.slug}/settings#taxes`);
    await expect(page.getByLabel("Tax category").locator("option")).toHaveText(["standard (taxes not set up)"]);
    await expect(page.getByLabel("Unit price (CAD)")).toHaveValue("");
    await shot(page, info, "gear-new-no-taxes");
    await page.getByLabel("Name").fill("Mirror ball");
    await page.getByLabel("Unit price (CAD)").fill("75");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Gear item created.")).toBeVisible();
    await expect(page.getByTestId("gear-tax-warning")).toContainText("No taxes are set up yet, so proposals with this item can't be sent.");
    await page.context().close();
  });

  test("media: real photo and video, disguised file and failed upload change nothing, order and archive", async ({}, info) => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/gear/${createdId}`);

    // A real photo, previewed before uploading.
    await page.getByLabel("Photo or video", { exact: true }).setInputFiles({ name: "bubbles.png", mimeType: "image/png", buffer: await transparentPng(320, 200) });
    await expect(page.getByTestId("media-uploader").locator("img")).toBeVisible();
    await page.getByLabel("Description (alt text)").fill("Bubble machine on a stand");
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added bubbles.png." })).toBeVisible();
    await expect(page.getByTestId("gear-gallery").getByRole("img", { name: "Bubble machine on a stand" })).toBeVisible();

    // HTML renamed to .png: rejected by content; nothing added, the photo stays.
    await upload(page, { name: "evil.png", mimeType: "image/png", buffer: htmlDisguisedAsPng() }, "Not really an image");
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "not a supported image or video" })).toBeVisible();
    await expect(page.getByLabel("Description (alt text)")).toHaveValue("Not really an image");
    expect(await mediaRows(createdId)).toHaveLength(1);
    const { data: objects } = await admin.storage.from("gear-media").list(`${tenant.id}/gear-items/${createdId}`);
    expect(objects).toHaveLength(1);
    await shot(page, info, "gear-media-rejected", false);

    // A failed Storage upload reports failure and changes nothing.
    await page.route("**/storage/v1/object/gear-media/**", (route) => route.fulfill({ status: 500, body: "{}" }));
    await upload(page, { name: "later.jpg", mimeType: "image/jpeg", buffer: await opaqueJpeg(200, 200) }, "Should not appear");
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "The upload didn't finish." })).toBeVisible();
    await expect(page.getByText("Added later.jpg")).toHaveCount(0);
    await page.unroute("**/storage/v1/object/gear-media/**");
    expect(await mediaRows(createdId)).toHaveLength(1);

    // A video: never autoplays; metadata only.
    await upload(page, { name: "demo.mp4", mimeType: "video/mp4", buffer: MP4 }, "Bubbles floating over the dance floor");
    await expect(page.getByRole("status").filter({ hasText: "Added demo.mp4." })).toBeVisible();
    const items = page.getByTestId("media-item");
    await expect(items).toHaveCount(2);
    for (const video of await page.locator("video").all()) {
      expect(await video.getAttribute("autoplay")).toBeNull();
      expect(await video.getAttribute("preload")).toBe("metadata");
    }
    await expect(items.nth(0)).toContainText("Shown first");

    // Move the video first; the gallery and proposals follow that order.
    await page.getByRole("button", { name: "Move video 2 earlier" }).click();
    await expect(items.nth(0)).toContainText("Video");
    await expect(items.nth(0)).toContainText("Shown first");
    expect((await mediaRows(createdId)).map((m) => [m.kind, m.sort_order])).toEqual([["video", 0], ["image", 1]]);
    await expect(page.getByRole("button", { name: "Move video 1 earlier" })).toBeDisabled();

    // Archive the video: hidden from the gallery, kept in Storage, restorable.
    await page.getByRole("button", { name: "Archive video" }).click();
    await expect(items.nth(0)).toContainText("Archived · hidden from new proposals");
    await expect(items.nth(1)).toContainText("Shown first");
    await expect(page.getByTestId("gear-gallery").locator("video")).toHaveCount(0);
    expect((await admin.storage.from("gear-media").list(`${tenant.id}/gear-items/${createdId}`)).data).toHaveLength(2);
    await shot(page, info, "gear-page-with-media");
    await page.getByRole("button", { name: "Restore video" }).click();
    await expect(items.nth(0)).not.toContainText("Archived");

    // The description (alt text) is editable on its own.
    await page.getByLabel("Description of photo 2 (alt text)").fill("Bubble machine, side view");
    await items.nth(1).getByRole("button", { name: "Save description" }).click();
    await expect(items.nth(1).getByText("Description saved.")).toBeVisible();
    expect((await mediaRows(createdId))[1].alt_text).toBe("Bubble machine, side view");
    await page.context().close();
  });

  test("a sent proposal keeps its copy after catalog edits and archived media", async () => {
    const page = await staffPage(tenant);
    const uplights = await gearId(tenant, "uplights_4");
    await page.goto(`/staff/${tenant.slug}/gear/${uplights}`);
    await expect(page.getByTestId("gear-uses")).toContainText("Premium");
    await upload(page, { name: "uplights.jpg", mimeType: "image/jpeg", buffer: await opaqueJpeg(400, 300) }, "Four uplights glowing teal");
    await expect(page.getByRole("status").filter({ hasText: "Added uplights.jpg." })).toBeVisible();

    const clientId = randomUUID();
    const eventId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Gear Client", email: `e2e-gear-client-${run}@example.test` }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: "Gear wedding", event_type: "wedding", event_date: "2027-09-18", venue_name: "E2E Hall" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    const proposalUrl = await sendProposalFromEventPage(page, tenant, eventId);
    const proposalId = proposalUrl.split("/").pop()!;
    const frozen = async () => (await must(admin.from("proposals").select("offer_snapshot, offer_sha256").eq("id", proposalId).single())).data!;
    const before = await frozen();
    const copy = (before.offer_snapshot as { gear: Record<string, { name: string; unit_price_cents: number; media: { alt_text: string }[] }> }).gear.uplights_4;
    expect(copy.unit_price_cents).toBe(12_000);
    expect(copy.media.map((m) => m.alt_text)).toEqual(["Four uplights glowing teal"]);

    // Change the catalog: name, price and the photo archived.
    await page.goto(`/staff/${tenant.slug}/gear/${uplights}`);
    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Name").fill("Uplights (pack of 4, new)");
    await page.getByLabel("Unit price (CAD)").fill("135");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gear item saved." })).toBeVisible();
    await page.getByRole("button", { name: "Archive photo" }).click();
    await expect(page.getByTestId("media-item").first()).toContainText("Archived");

    const after = await frozen();
    expect(after).toEqual(before);
    // The sent proposal still shows the archived photo.
    await page.goto(proposalUrl);
    await expect(page.getByRole("img", { name: "Four uplights glowing teal" }).first()).toBeVisible();
    await expect(page.getByRole("img", { name: "Four uplights glowing teal" }).first()).toHaveJSProperty("complete", true);
    expect(await page.getByRole("img", { name: "Four uplights glowing teal" }).first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.context().close();
  });

  test("archive: a confirmation naming where it's used; restore", async ({}, info) => {
    const page = await staffPage(tenant);
    const mic = await gearId(tenant, "wireless_mic");
    await page.goto(`/staff/${tenant.slug}/gear/${mic}`);
    const uses = page.getByTestId("gear-uses");
    await expect(uses).toContainText("Package");
    await expect(uses).toContainText("Proposal template");
    await expect(uses).toContainText("Rule");
    await expect(uses.getByRole("link", { name: "Wedding (DEMO)" })).toHaveAttribute("href", new RegExp(`/staff/${tenant.slug}/templates/`));
    await page.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm archiving the gear item" });
    await expect(dialog).toContainText("Proposals that include it can't be previewed or sent");
    await expect(dialog).toContainText("Proposals already sent keep its details, price and photos.");
    await shot(page, info, "gear-archive-confirmation", false);
    await dialog.getByRole("button", { name: "Archive gear item" }).click();
    await expect(page.getByText("This gear item is archived.")).toBeVisible();
    expect((await must(admin.from("gear_items").select("active").eq("id", mic).single())).data!.active).toBe(false);
    expect((await must(admin.from("package_items").select("id").eq("gear_item_id", mic))).data!.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Restore gear item" }).click();
    await expect(page.getByText("Gear item restored.")).toBeVisible();
    expect((await must(admin.from("gear_items").select("active").eq("id", mic).single())).data!.active).toBe(true);
    await page.context().close();
  });

  test("another business and a suspended workspace are refused", async () => {
    const outsider = await staffPage(other);
    expect((await outsider.goto(`/staff/${tenant.slug}/gear`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${tenant.slug}/gear/${createdId}`))?.status()).toBe(404);
    expect((await outsider.goto(`/staff/${other.slug}/gear/${createdId}`))?.status()).toBe(404);
    // (Storage refusing another business's files is covered by tests/integration/storage-gear-media.test.ts.)
    await outsider.context().close();

    const page = await staffPage(suspended);
    await page.goto(`/staff/${suspended.slug}/gear`);
    await expect(page.getByTestId("gear-row")).toHaveCount(5);
    suspendLocally(suspended.id);
    await page.goto(`/staff/${suspended.slug}/gear`);
    await expect(page).toHaveURL(/\/unavailable$/);
    await page.goto(`/staff/${suspended.slug}/gear/new`);
    await expect(page).toHaveURL(/\/unavailable$/);
    await page.context().close();
  });

  test("on a phone: stacked rows with thumbnails, item page and form fit", async ({}, info) => {
    for (const width of [390, 320]) {
      const page = await staffPage(tenant, { ...PHONE, viewport: { width, height: 844 } });
      for (const path of ["gear", "gear?archived=1", `gear/${createdId}`, "gear/new"]) {
        await page.goto(`/staff/${tenant.slug}/${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await sideways(page), `${path} at ${width}`).toBeLessThanOrEqual(0);
      }
      if (width === 390) {
        await page.goto(`/staff/${tenant.slug}/gear`);
        await expect(page.getByTestId("gear-thumb").first()).toBeVisible();
        await shot(page, info, "gear-list-phone");
        await page.goto(`/staff/${tenant.slug}/gear/${createdId}`);
        await shot(page, info, "gear-page-phone");
        await page.goto(`/staff/${tenant.slug}/gear/new`);
        await shot(page, info, "gear-new-phone");
      }
      await page.context().close();
    }
  });
});
