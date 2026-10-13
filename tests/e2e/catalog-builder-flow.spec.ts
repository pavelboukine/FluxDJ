/**
 * Gear categories, paired gear, package gear order and the proposal builder
 * in real browsers, in a dedicated test business: a category chosen from the
 * suggestions and pieces per unit on the gear form, a photo uploaded without
 * typing alt text, the category filter and manager, every gear choice
 * visible without typing (grouped, collapsible, searchable), drag and
 * keyboard reordering of a package's gear, a template draft that opens
 * straight into editing, add-ons grouped by category, a custom price shown in
 * the live preview before saving and then saved, package base prices for
 * one proposal (kept or dropped by package id when the template changes), the
 * client's page showing only the effective prices, the pair wording and the
 * chosen order, then submission, approval and a contract whose prices and
 * quantity wording match the approved proposal and survive catalog edits.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff, waitForEmail } from "./support";
import { must } from "./booking";
import { archiveTestTenant, createTestTenant, publishContractTemplate, type TestTenant } from "./tenant";
import { opaqueJpeg } from "../support/logo-fixtures";

test.describe.serial("gear catalog and proposal builder", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let page: Page;
  const run = randomUUID().slice(0, 6);
  const heads = `E2E Moving Heads ${run}`;
  const clientEmail = `catalog-client-${run}@example.test`;
  let headsId = "";
  let eventId = "";
  let proposalUrl = "";
  let contractUrl = "";
  const cad = (cents: number) => `${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2 })} CAD`;

  const gearId = async (key: string) => (await must(admin.from("gear_items").select("id").eq("tenant_id", tenant.id).eq("key", key).single())).data!.id as string;
  const packageId = async (key: string) => (await must(admin.from("packages").select("id").eq("tenant_id", tenant.id).eq("key", key).single())).data!.id as string;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("catalog-builder", { catalog: true });
    // Enough gear that the old picker showed only eight of them.
    await must(
      admin.from("gear_items").insert(
        Array.from({ length: 9 }, (_, i) => ({ tenant_id: tenant.id, key: `extra_${i}`, name: `Extra effect ${i}`, default_price_cents: 1_000 + i })),
      ),
    );
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Sam & Alex", email: clientEmail }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `E2E Catalog Wedding ${run}`, event_type: "wedding", event_date: "2027-09-18" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    // A second template that offers Essential and Premium but not Signature.
    const deluxe = randomUUID();
    const corporate = randomUUID();
    await must(admin.from("packages").insert({ id: deluxe, tenant_id: tenant.id, key: "deluxe", name: "Deluxe", base_price_cents: 400_000, sort_order: 4 }));
    await must(admin.from("proposal_templates").insert({ id: corporate, tenant_id: tenant.id, name: "E2E Corporate", expiry_days: 14 }));
    const { data: pkgs } = await must(admin.from("packages").select("id, key").eq("tenant_id", tenant.id));
    const pkg = (key: string) => pkgs!.find((p) => p.key === key)!.id;
    await must(
      admin.from("proposal_template_packages").insert([
        { tenant_id: tenant.id, template_id: corporate, package_id: pkg("essential"), sort_order: 1 },
        { tenant_id: tenant.id, template_id: corporate, package_id: pkg("premium"), sort_order: 2 },
        { tenant_id: tenant.id, template_id: corporate, package_id: deluxe, sort_order: 3 },
      ]),
    );
    await must(admin.from("proposal_templates").update({ default_package_id: pkg("premium") }).eq("id", corporate));
    page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signInStaff(page, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("gear: a suggested category, a pair of lights, and a photo without typing alt text", async () => {
    await page.goto(`/staff/${tenant.slug}/gear/new`);
    await page.getByLabel("Name").fill(heads);
    await page.getByLabel("Category (optional)").selectOption({ label: "Lighting" });
    await page.getByLabel("Unit price (CAD)").fill("250");
    await page.getByLabel("Unit (optional)").fill("pair");
    await page.getByLabel("Pieces per unit").fill("2");
    await page.getByLabel("Pieces are called (optional)").fill("lights");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Gear item created.")).toBeVisible();
    headsId = /\/gear\/([0-9a-f-]{36})\?created=1$/.exec(page.url())![1];

    const { data: row } = await must(admin.from("gear_items").select("default_price_cents, unit_label, pieces_per_unit, piece_label, category:gear_categories!gear_items_category_fk(name, sort_order)").eq("id", headsId).single());
    expect(row).toEqual({ default_price_cents: 25_000, unit_label: "pair", pieces_per_unit: 2, piece_label: "lights", category: { name: "Lighting", sort_order: 20 } });
    await expect(page.getByTestId("gear-category")).toHaveText("Lighting");
    await expect(page.getByTestId("gear-pieces")).toContainText(`Clients see “1 pair of ${heads} (2 lights)”.`);
    await expect(page.getByTestId("gear-price").locator("..")).toContainText("per pair (2 lights)");

    // Uploading needs no description: the item's name is used.
    await page.getByLabel("Photo or video", { exact: true }).setInputFiles({ name: "heads.jpg", mimeType: "image/jpeg", buffer: await opaqueJpeg(400, 300) });
    await expect(page.getByLabel("Description (alt text, optional)")).toHaveAttribute("placeholder", heads);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added heads.jpg." })).toBeVisible();
    const { data: media } = await must(admin.from("gear_media").select("alt_text").eq("gear_item_id", headsId));
    expect(media).toEqual([{ alt_text: heads }]);
    await expect(page.getByTestId("gear-gallery").getByRole("img", { name: heads })).toBeVisible();

    // Another item into a new category typed on its form.
    await page.goto(`/staff/${tenant.slug}/gear/${await gearId("wireless_mic")}`);
    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Category (optional)").selectOption({ label: "New category…" });
    await page.getByLabel("New category name").fill("Microphones");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByTestId("gear-category")).toHaveText("Microphones");

    // The list filters by category; categories are renamed in place.
    await page.goto(`/staff/${tenant.slug}/gear`);
    await page.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: "Lighting" });
    await expect(page).toHaveURL(/category=[0-9a-f-]{36}/);
    await expect(page.getByTestId("gear-row")).toHaveCount(1);
    await expect(page.getByTestId("gear-row")).toContainText(heads);
    await page.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: "Uncategorized" });
    await expect(page.getByTestId("gear-row").first()).toContainText("Uncategorized");
    await page.getByText("Categories (2)").click();
    await page.getByLabel("Name of category 2").fill("Audio");
    await page.getByTestId("category-row").nth(1).getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Category renamed.")).toBeVisible();
    const { data: categories } = await must(admin.from("gear_categories").select("name").eq("tenant_id", tenant.id).order("sort_order"));
    expect(categories!.map((c) => c.name)).toEqual(["Lighting", "Audio"]);
  });

  test("package: every choice without typing, grouped and collapsible; drag and keys set the order clients see", async () => {
    await page.goto(`/staff/${tenant.slug}/packages/${await packageId("signature")}`);
    await page.getByRole("button", { name: "Edit included gear" }).click();
    const picker = page.getByRole("group", { name: "Add gear" });
    // 15 active items, 4 included: all 11 others are listed, in category groups, with no "type to find others".
    await expect(picker.getByRole("button", { name: /^Add / })).toHaveCount(11);
    await expect(page.getByText(/Type to find others/)).toHaveCount(0);
    await expect(picker.getByRole("button", { name: /^Lighting/ })).toHaveAttribute("aria-expanded", "true");
    await picker.getByRole("button", { name: /^Lighting/ }).click();
    await expect(picker.getByRole("button", { name: `Add ${heads}` })).toHaveCount(0);
    // Searching finds it anyway.
    await page.getByLabel("Find gear to add").fill("moving");
    await expect(picker.getByRole("button", { name: `Add ${heads}` })).toBeVisible();
    await page.getByLabel("Find gear to add").fill("");

    const rows = page.getByTestId("included-row");
    const all = ["Additional-location speaker", "Dance floor lighting", "Main reception sound system", "Wireless microphone"];
    const names = async () => (await rows.allTextContents()).map((t) => all.find((n) => t.includes(n)));
    expect(await names()).toEqual(all);

    // Drag the main system to the top with its handle.
    const handle = page.getByRole("button", { name: "Reorder Main reception sound system" });
    const from = (await handle.boundingBox())!;
    const top = (await rows.first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 8 });
    await page.mouse.up();
    expect(await names()).toEqual(["Main reception sound system", "Additional-location speaker", "Dance floor lighting", "Wireless microphone"]);
    // The keyboard: arrow keys on a focused handle.
    await page.getByRole("button", { name: "Reorder Dance floor lighting" }).focus();
    await page.keyboard.press("ArrowUp");
    expect(await names()).toEqual(["Main reception sound system", "Dance floor lighting", "Additional-location speaker", "Wireless microphone"]);
    await expect(page.getByRole("button", { name: "Reorder Dance floor lighting" })).toBeFocused();
    // The pair of moving heads joins the package, last.
    await page.getByLabel("Find gear to add").fill("moving");
    await page.getByLabel("Find gear to add").press("Enter");
    await expect(rows).toHaveCount(5);

    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.locator("#included").getByRole("status").filter({ hasText: "Included gear saved." })).toBeVisible();
    await expect(page.getByTestId("included-item")).toHaveText([/Main reception sound system/, /Dance floor lighting/, /Additional-location speaker/, /Wireless microphone/, new RegExp(heads)]);
    await expect(page.getByTestId("included-item").last()).toContainText("× 1 pair (2 lights)");
    const { data: items } = await must(admin.from("package_items").select("gear_item_id, sort_order").eq("package_id", await packageId("signature")).order("sort_order"));
    expect(items!.map((i) => i.gear_item_id)).toEqual([
      await gearId("main_sound_system"), await gearId("dance_floor_lighting"), await gearId("additional_location_speaker"), await gearId("wireless_mic"), headsId,
    ]);
  });

  test("builder: a template draft opens for editing; a custom price shows in the preview before saving, then saves", async () => {
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await page.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
    await page.getByRole("button", { name: "Start proposal draft" }).click();
    await page.waitForURL("**/proposals/**");
    proposalUrl = page.url();

    // No second "start from a template": changing it is a secondary, explained action.
    await expect(page.getByText("Start from a template", { exact: true })).toHaveCount(0);
    await expect(page.locator("#change-template summary")).toContainText("Started from Wedding (DEMO)");
    await expect(page.getByTestId("addon-row")).toHaveCount(4);
    const preview = page.getByRole("region", { name: "Client preview (scrolls separately)" });
    const card = (name: string) => preview.getByTestId("package-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

    // Package base prices for this proposal only: shown in the preview before saving.
    const slot = (n: number) => page.getByTestId("package-slot").nth(n - 1);
    await slot(1).getByRole("button", { name: "Edit price of Essential for this proposal" }).click();
    await slot(1).getByLabel("This proposal (CAD)").fill("1400");
    await slot(2).getByRole("button", { name: "Edit price of Signature for this proposal" }).click();
    await slot(2).getByLabel("This proposal (CAD)").fill("2000");
    await expect(slot(2).getByText("Custom price")).toBeVisible();
    await expect(slot(2)).toContainText("Standard $2,200.00");
    await expect(card("Signature")).toContainText("$2,000.00");
    await expect(card("Essential")).toContainText("$1,400.00");
    await expect(card("Signature")).not.toContainText("$2,200.00");
    await expect(page.getByTestId("preview-status")).toContainText("Showing your unsaved changes");
    const draftRow = async () => (await must(admin.from("proposals").select("draft_version, draft_offer").eq("event_id", eventId).single())).data!;
    expect((await draftRow()).draft_offer as object).not.toHaveProperty("price_overrides");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    const ids = { essential: await packageId("essential"), signature: await packageId("signature") };
    expect((await draftRow()).draft_offer).toMatchObject({
      price_overrides: [{ package_id: ids.essential, unit_price_cents: 140_000 }, { package_id: ids.signature, unit_price_cents: 200_000 }],
    });

    // A template without Signature: its price is dropped, Essential's is kept (matched by package id).
    const applyTemplate = async (name: string) => {
      if (!(await page.locator("#change-template").evaluate((el) => (el as HTMLDetailsElement).open))) await page.locator("#change-template summary").click();
      await page.getByLabel("Template").selectOption({ label: name });
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Apply template" }).click();
      await page.waitForURL(/\?applied=\d+$/);
    };
    await applyTemplate("E2E Corporate");
    await expect(slot(1).getByText("Custom price")).toBeVisible();
    await expect(slot(1).getByLabel("This proposal (CAD)")).toHaveValue("1400.00");
    await expect(slot(3)).toContainText("$4,000.00 base price · standard price");
    expect((await draftRow()).draft_offer).toMatchObject({ price_overrides: [{ package_id: ids.essential, unit_price_cents: 140_000 }] });
    await applyTemplate("Wedding (DEMO)");
    await expect(slot(2).getByTestId("price-standard")).toContainText("$2,200.00 base price · standard price");
    await slot(2).getByRole("button", { name: "Edit price of Signature for this proposal" }).click();
    await slot(2).getByLabel("This proposal (CAD)").fill("2000");
    // Reset brings Essential back to its standard price.
    await slot(1).getByRole("button", { name: "Reset Essential to the standard price" }).click();
    await expect(slot(1).getByTestId("price-standard")).toContainText("$1,500.00 base price · standard price");

    // Add-ons come from a grouped catalog; the moving heads join them.
    await page.getByTestId("addons-editor").getByLabel("Find gear to add").fill("moving");
    await page.getByRole("button", { name: `Add ${heads}` }).click();
    await expect(page.getByTestId("addon-row")).toHaveCount(5);
    await page.getByLabel(`Maximum quantity of ${heads}`).fill("4");

    await expect(page.getByTestId("preview-status")).toContainText("Showing your unsaved changes");
    // Add-ons from several categories are grouped for the client.
    await expect(preview.getByTestId("addon-group")).toHaveCount(3);
    await expect(preview.getByTestId("addon-group").first()).toContainText("Lighting");
    await expect(preview.getByTestId("addon-group").first()).toContainText("$250.00 per pair (2 lights)");

    // A custom price for this proposal only.
    const uplights = page.getByTestId("addon-row").filter({ hasText: "Uplights (pack of 4)" });
    await uplights.getByRole("button", { name: "Edit price of Uplights (pack of 4) for this proposal" }).click();
    await uplights.getByLabel("This proposal (CAD)").fill("100");
    await expect(uplights.getByText("Custom price")).toBeVisible();
    await expect(uplights).toContainText("Standard $120.00");
    await expect(preview.getByRole("listitem").filter({ hasText: "Uplights (pack of 4)" }).filter({ hasText: "$100.00 per pack" })).toBeVisible();
    await expect(preview.getByRole("listitem").filter({ hasText: "Uplights (pack of 4)" }).filter({ hasText: "Adds $100.00" })).toBeVisible();
    await expect(page.getByTestId("preview-status")).toContainText("Showing your unsaved changes");
    await expect(page.getByText("Save your changes before sending.")).toBeVisible();

    // Reset brings back the standard price.
    const mic = page.getByTestId("addon-row").filter({ hasText: "Wireless microphone" });
    await mic.getByRole("button", { name: "Edit price of Wireless microphone for this proposal" }).click();
    await mic.getByLabel("This proposal (CAD)").fill("40");
    await mic.getByRole("button", { name: "Reset Wireless microphone to the standard price" }).click();
    await expect(mic.getByTestId("price-standard")).toContainText("$50.00 per mic · standard price");

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    await expect(page.getByTestId("preview-status")).toContainText("Shows the saved draft.");
    const { data: draft } = await must(admin.from("proposals").select("draft_offer").eq("event_id", eventId).single());
    const offer = draft!.draft_offer as { price_overrides?: unknown; addons: { gear_item_id: string }[] };
    expect(offer.price_overrides).toEqual([
      { package_id: ids.signature, unit_price_cents: 200_000 },
      { gear_item_id: await gearId("uplights_4"), unit_price_cents: 10_000 },
    ]);
    expect(offer.addons.map((a) => a.gear_item_id)).toContain(headsId);
    const { data: catalogPrice } = await must(admin.from("gear_items").select("default_price_cents").eq("key", "uplights_4").eq("tenant_id", tenant.id).single());
    expect(catalogPrice!.default_price_cents).toBe(12_000);
    const { data: catalogPackage } = await must(admin.from("packages").select("base_price_cents").eq("id", ids.signature).single());
    expect(catalogPackage!.base_price_cents).toBe(220_000);

    // Changing the template explains what it replaces and asks first; declining changes nothing.
    if (!(await page.locator("#change-template").evaluate((el) => (el as HTMLDetailsElement).open))) await page.locator("#change-template summary").click();
    await page.getByLabel("Template").selectOption({ label: "Wedding (DEMO)" });
    let prompt = "";
    page.once("dialog", (d) => {
      prompt = d.message();
      void d.dismiss();
    });
    await page.getByRole("button", { name: "Apply template" }).click();
    await expect.poll(() => prompt).toContain("Custom prices stay for the packages and gear the template also offers.");
    await expect(page.getByTestId("addon-row")).toHaveCount(5);
  });

  test("client: only the effective prices, the pair wording and the package's order; submit", async () => {
    await page.goto(proposalUrl);
    const sentAt = Date.now();
    await page.getByRole("button", { name: "Review and send…" }).click();
    await page.getByRole("dialog", { name: "Confirm sending" }).getByRole("button", { name: "Send proposal now" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();

    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    const link = new RegExp(`(http://127\\.0\\.0\\.1:3000/${tenant.slug}/p#[A-Za-z0-9_-]{43})`).exec(email.text)![1];
    const client = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await client.goto(link);
    await client.waitForURL(new RegExp(`/${tenant.slug}/proposals/[0-9a-f-]{36}$`));

    // The client sees this proposal's prices only: no catalog price, no "discount".
    const signature = client.getByTestId("package-card").filter({ has: client.getByRole("heading", { name: "Signature", exact: true }) });
    await expect(signature).toContainText("$2,000.00");
    await expect(client.locator("body")).not.toContainText("$2,200.00");
    await expect(client.locator("body")).not.toContainText(/discount|custom price|standard price/i);
    await expect(client.getByRole("radio", { name: /^Signature/ })).toBeChecked();

    await expect(client.getByRole("heading", { name: "Add-ons", exact: true })).toBeVisible();
    const uplights = client.getByRole("listitem").filter({ has: client.getByRole("heading", { name: "Uplights (pack of 4)" }) }).last();
    await expect(uplights).toContainText("$100.00 per pack");
    await expect(client.getByRole("listitem").filter({ hasText: heads }).filter({ hasText: "$250.00 per pair (2 lights)" })).toBeVisible();
    // Signature's gear in the order staff chose, the pair worded as such.
    const included = client.locator("section", { has: client.getByRole("heading", { name: /What's included in Signature/ }) });
    await expect(included.getByRole("heading", { level: 3 })).toHaveText(["Main reception sound system", "Dance floor lighting", "Additional-location speaker", "Wireless microphone", heads]);
    await expect(included.getByRole("listitem").last()).toContainText("1 pair (2 lights) included");

    // Two more pairs of moving heads: four lights, priced per pair.
    await client.getByRole("button", { name: `More ${heads}` }).click();
    await client.getByRole("button", { name: `More ${heads}` }).click();
    await client.getByRole("group", { name: /ceremony take place/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /cocktail hour/ }).getByLabel("Same room as the reception").check();
    await client.getByRole("group", { name: /speeches/i }).getByLabel("No").check();
    const summary = client.locator("#price-summary");
    await expect(summary).toContainText("Signature package$2,000.00");
    await expect(summary).toContainText(`2 pairs of ${heads} (4 lights)`);
    await expect(summary).toContainText("$500.00");
    await expect(client.getByText("All changes saved")).toBeVisible();
    await client.getByRole("button", { name: "Review proposal" }).click();
    await expect(client.getByRole("heading", { name: "Review your choices" })).toBeVisible();
    await client.getByRole("button", { name: "Submit proposal" }).click();
    await expect(client.getByText("Submitted for DJ review.")).toBeVisible();
    await client.context().close();
  });

  test("approval and contract: approved custom prices, matching quantity wording, unchanged by later catalog edits", async () => {
    const templateName = `E2E Services ${run}`;
    await publishContractTemplate(tenant, templateName, "DEMO agreement for {{event.title}}", [
      { heading: "Services", body: "{{package.name}} ({{package.price}})\n{{package.included}}\n{{gear.extras}}" },
      { heading: "Price", body: "Total {{pricing.total}}. Deposit {{payment.deposit}}. Balance {{payment.balance}}." },
    ]);
    await page.goto(proposalUrl);
    await page.getByRole("button", { name: "Approve…" }).click();
    await page.getByRole("dialog", { name: "Confirm approval" }).getByRole("button", { name: "Approve selection" }).click();
    await expect(page.getByText(/Next: generate the contract draft\. The event is not booked\./)).toBeVisible();

    const { data: selection } = await must(
      admin.from("proposal_selections").select("subtotal_cents, tax_cents, total_cents, proposals!inner(event_id)").eq("proposals.event_id", eventId).single(),
    );
    // The approved totals, as the database verified and stored them.
    const total = selection!.total_cents;
    const deposit = Number((BigInt(total) * BigInt(5000) + BigInt(5000)) / BigInt(10000));

    await page.getByLabel("Template version").selectOption({ label: `${templateName} · version 1 · DEMO (latest published)` });
    await page.getByRole("button", { name: "Generate contract draft" }).click();
    await page.waitForURL(new RegExp(`/staff/${tenant.slug}/contracts/[0-9a-f-]{36}$`));
    contractUrl = page.url();
    const article = page.locator("article");
    await expect(article).toContainText(`Signature (${cad(200_000)})`);
    await expect(article).toContainText(`- 1 pair of ${heads} (2 lights)`);
    await expect(article).toContainText("- 1 × Main reception sound system");
    await expect(article).toContainText(`- 2 pairs of ${heads} (4 lights): ${cad(50_000)}`);
    await expect(article).toContainText(`- 1 × Uplights (pack of 4): ${cad(10_000)}`);
    await expect(article).toContainText(`Total ${cad(total)}. Deposit ${cad(deposit)}. Balance ${cad(total - deposit)}.`);
    const { data: contract } = await must(admin.from("contracts").select("total_cents, deposit_cents, balance_cents, rendered_content, commercial_snapshot").eq("event_id", eventId).single());
    expect(contract).toMatchObject({ total_cents: total, deposit_cents: deposit, balance_cents: total - deposit, commercial_snapshot: { package: { base_price_cents: 200_000 } } });

    // The catalog's prices never changed; editing the catalog now changes neither the sent proposal nor the contract.
    const { data: proposal } = await must(admin.from("proposals").select("id, offer_snapshot").eq("event_id", eventId).eq("status", "approved").single());
    expect((await must(admin.from("packages").select("base_price_cents").eq("id", await packageId("signature")).single())).data!.base_price_cents).toBe(220_000);
    expect((await must(admin.from("gear_items").select("default_price_cents").eq("id", headsId).single())).data!.default_price_cents).toBe(25_000);
    await must(admin.from("gear_items").update({ name: "Renamed heads", pieces_per_unit: 1, piece_label: null, unit_label: "unit", default_price_cents: 99_900 }).eq("id", headsId));
    await must(admin.from("packages").update({ base_price_cents: 999_900 }).eq("id", await packageId("signature")));
    const { data: after } = await must(admin.from("contracts").select("total_cents, deposit_cents, balance_cents, rendered_content, commercial_snapshot").eq("event_id", eventId).single());
    expect(after).toEqual(contract);
    expect((await must(admin.from("proposals").select("offer_snapshot").eq("id", proposal!.id).single())).data!.offer_snapshot).toEqual(proposal!.offer_snapshot);
    await page.goto(contractUrl);
    await expect(page.locator("article")).toContainText(`- 2 pairs of ${heads} (4 lights): ${cad(50_000)}`);
  });
});
