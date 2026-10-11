/**
 * The contract template editor and Word import in a real browser, in a
 * dedicated test business (never BOUPROD): sections are edited, reordered and
 * given fields at the cursor, the preview shows example values, a stale tab
 * gets a conflict; a Word document is converted and reviewed, nothing is saved
 * until the DJ acknowledges the warnings and creates the draft, and bad files
 * are refused. FLUX_BOUPROD_DOCX=/path/to/file.docx also imports that real
 * agreement (into the test business only).
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { EXAMPLE_VALUES } from "../../src/lib/contracts/fields";
import { docx, p, table } from "../support/docx";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
let staff: Page;
const run = randomUUID().slice(0, 6);
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const templateCount = async () => (await admin.from("contract_templates").select("id").eq("tenant_id", tenant.id)).data!.length;
const card = (page: Page, n: number) => page.getByTestId("section-card").nth(n - 1);
const upload = (page: Page, name: string, buffer: Buffer) =>
  page.getByLabel("Word document (.docx, up to 4 MB)").setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer });

test.describe.serial("contract editor and Word import", () => {
  test.beforeAll(async ({ browser }) => {
    tenant = await createTestTenant("ceditor");
    staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("the editor: sections are added, reordered and given fields at the cursor; the preview uses example values; stale tabs conflict", async () => {
    await staff.goto(`/staff/${tenant.slug}/contract-templates/new`);
    await staff.getByRole("link", { name: /Write it here/ }).click();
    await staff.getByLabel("Template name").fill(`E2E editor ${run}`);
    await staff.getByLabel("Document title").fill("Services agreement");
    await staff.getByLabel("Heading of section 1").fill("Payment");
    const body1 = staff.getByLabel("Text of section 1");
    await body1.fill("The total is today.");
    // Put the cursor after "The total is ", then insert the Total field from the searchable menu.
    await body1.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(13, 13));
    await card(staff, 1).getByRole("button", { name: "Insert field" }).click();
    const menu = staff.getByRole("group", { name: "Insert a field into Payment" });
    await expect(menu.getByLabel("Find a field")).toBeFocused();
    await menu.getByLabel("Find a field").fill("approved total");
    await menu.getByRole("button", { name: /\{\{pricing\.total\}\}/ }).click();
    await expect(body1).toHaveValue("The total is {{pricing.total}}today.");
    await expect(body1).toBeFocused();
    // A list field goes on its own line, wherever the cursor is.
    await body1.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
    await card(staff, 1).getByRole("button", { name: "Insert field" }).click();
    await staff.getByRole("group", { name: "Insert a field into Payment" }).getByRole("button", { name: /\{\{package\.included\}\}/ }).click();
    await expect(body1).toHaveValue("The \n{{package.included}}\ntotal is {{pricing.total}}today.");
    await body1.fill("The total is {{pricing.total}} today.");
    // Escape closes the menu and returns to the text.
    await card(staff, 1).getByRole("button", { name: "Insert field" }).click();
    await staff.keyboard.press("Escape");
    await expect(staff.getByRole("group", { name: "Insert a field into Payment" })).toHaveCount(0);
    await expect(body1).toBeFocused();

    await staff.getByRole("button", { name: "Add section", exact: true }).click();
    await staff.getByLabel("Heading of section 2").fill("Parties");
    await staff.getByLabel("Text of section 2").fill("{{client.name}} hires us.");
    await staff.getByRole("button", { name: "Move Parties up" }).click();
    await expect(staff.getByLabel("Heading of section 1")).toHaveValue("Parties");

    const preview = staff.getByTestId("contract-preview");
    await expect(staff.getByTestId("preview-note")).toContainText("Preview with example values.");
    await expect(preview).toContainText(`${EXAMPLE_VALUES["client.name"]} hires us.`);
    await expect(preview).toContainText(`The total is ${EXAMPLE_VALUES["pricing.total"]} today.`);
    await expect(preview.getByRole("heading")).toHaveText(["Services agreement", "Parties", "Payment"]);

    await staff.getByRole("button", { name: "Create draft" }).click();
    await staff.waitForURL(/\/contract-templates\/[0-9a-f-]{36}\?created=1$/);
    const templateId = new URL(staff.url()).pathname.split("/").pop()!;
    const sections = async () => (await admin.from("contract_template_versions").select("sections").eq("template_id", templateId).single()).data!.sections;
    expect(await sections()).toEqual([
      { heading: "Parties", body: "{{client.name}} hires us." },
      { heading: "Payment", body: "The total is {{pricing.total}} today." },
    ]);

    // A stale tab gets a conflict instead of overwriting.
    const stale = await staff.context().newPage();
    await stale.goto(staff.url());
    await staff.getByLabel("Text of section 2").fill("The total is {{pricing.total}}, due today.");
    await staff.getByRole("button", { name: "Save draft" }).click();
    await expect(staff.getByText("Draft saved. It is not published yet.")).toBeVisible();
    await stale.getByLabel("Text of section 1").fill("Changed elsewhere.");
    await stale.getByRole("button", { name: "Save draft" }).click();
    await expect(stale.locator("main").getByRole("alert")).toContainText("Someone else saved changes first");
    await expect(stale.getByLabel("Text of section 1")).toHaveValue("Changed elsewhere.");
    await stale.close();
    expect((await sections())[1].body).toBe("The total is {{pricing.total}}, due today.");

    // On a phone: Edit / Preview switch, no sideways scrolling.
    const phone = await staff.context().newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(staff.url());
    await expect(phone.getByLabel("Text of section 1")).toBeVisible();
    await expect(phone.getByTestId("contract-preview")).toBeHidden();
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(phone.getByTestId("contract-preview")).toBeVisible();
    await expect(phone.getByLabel("Text of section 1")).toBeHidden();
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("Word import: the converted agreement and its warnings are reviewed; nothing is saved until the draft is created", async () => {
    const before = await templateCount();
    const file = docx(
      [
        p("Wedding DJ Agreement", { style: "Title" }),
        p("Made by and between the DJ and the Client."),
        p("1. Services", { style: "Heading1" }),
        p("Dear {{client.name}}, we provide:"),
        p("Ceremony music", { list: { num: 1 } }),
        p("Reception music", { list: { num: 1 } }),
        p("Equipment:"),
        table([["Item", "Price"], ["Speakers", "500"], ["", ""]]),
        p("2. Payment", { style: "Heading1" }),
        p("Deposit: ________ due on signing."),
      ].join(""),
      { "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p("Confidential")}</w:hdr>` },
    );
    await staff.goto(`/staff/${tenant.slug}/contract-templates/new`);
    await staff.getByRole("link", { name: /Import a Word document/ }).click();
    await upload(staff, "Wedding agreement.docx", file);
    await staff.getByRole("button", { name: "Convert document" }).click();
    await expect(staff.getByRole("heading", { name: "Review the import" })).toBeVisible();
    expect(await templateCount()).toBe(before);

    const previewed = staff.getByTestId("import-preview");
    await expect(previewed.getByRole("heading")).toHaveText(["Wedding DJ Agreement", "Introduction", "1. Services", "2. Payment"]);
    await expect(previewed).toContainText("1. Ceremony music\n2. Reception music");
    await expect(previewed).toContainText("Item | Price\nSpeakers | 500");
    const reviewList = staff.getByTestId("import-review");
    await expect(reviewList.getByTestId("issue-fields")).toContainText("Client name ({{client.name}})");
    await expect(reviewList.getByTestId("issue-numbering")).toContainText("2 numbered list items");
    await expect(reviewList.getByTestId("issue-tables")).toContainText("1 empty row left out");
    await expect(reviewList.getByTestId("issue-header-footer")).toContainText("Header: Confidential");
    await expect(staff.getByTestId("issue-blanks")).toContainText("“Deposit: ___” could be the field Deposit");
    await expect(staff.getByTestId("issue-duplicates")).toContainText("Parties and contact details");

    // Every warning needs a tick: creating is refused until then (and saves nothing).
    await staff.getByLabel("Template name").fill(`E2E import ${run}`);
    await staff.getByRole("button", { name: "Create draft" }).click();
    await expect(staff.getByRole("heading", { name: "Review the import" })).toBeVisible();
    expect(await templateCount()).toBe(before);
    await reviewList.getByRole("checkbox", { name: "Add this text as a final section, “Header and footer text”" }).check();
    for (const box of await reviewList.getByRole("checkbox", { name: /I've checked this|Use these as fields/ }).all()) await box.check();
    await staff.getByRole("button", { name: "Create draft" }).click();
    await staff.waitForURL(/\/contract-templates\/[0-9a-f-]{36}\?created=1$/);
    const templateId = new URL(staff.url()).pathname.split("/").pop()!;
    const { data: version } = await admin.from("contract_template_versions").select("title, sections, published_at").eq("template_id", templateId).single();
    expect(version!.title).toBe("Wedding DJ Agreement");
    expect(version!.published_at).toBeNull();
    expect(version!.sections).toEqual([
      { heading: "Introduction", body: "Made by and between the DJ and the Client." },
      { heading: "1. Services", body: "Dear {{client.name}}, we provide:\n\n1. Ceremony music\n2. Reception music\n\nEquipment:\n\nItem | Price\nSpeakers | 500" },
      { heading: "2. Payment", body: "Deposit: ________ due on signing." },
      { heading: "Header and footer text", body: "Header: Confidential" },
    ]);
    // The draft opens in the editor.
    await expect(staff.getByLabel("Heading of section 2")).toHaveValue("1. Services");
  });

  test("bad files are refused with a clear reason; an unknown field blocks the draft; cancelling saves nothing", async () => {
    const before = await templateCount();
    await staff.goto(`/staff/${tenant.slug}/contract-templates/new?start=import`);
    await upload(staff, "not-really.docx", Buffer.from("just some text"));
    await staff.getByRole("button", { name: "Convert document" }).click();
    await expect(staff.locator("main").getByRole("alert")).toHaveText("This isn't a Word document (.docx).");

    const tracked = docx(`<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>New wording</w:t></w:r></w:ins></w:p>`);
    await upload(staff, "tracked.docx", tracked);
    await staff.getByRole("button", { name: "Convert document" }).click();
    await expect(staff.locator("main").getByRole("alert")).toContainText("This document has tracked changes.");

    await upload(staff, "unknown.docx", docx(p("Terms", { style: "Heading1" }) + p("Dear {{client.nickname}}.")));
    await staff.getByRole("button", { name: "Convert document" }).click();
    await expect(staff.getByTestId("import-blocking")).toContainText("{{client.nickname}}");
    await expect(staff.getByRole("button", { name: "Create draft" })).toHaveCount(0);
    await staff.getByRole("button", { name: "Choose another file" }).click();
    await staff.getByRole("link", { name: "Cancel" }).click();
    await staff.waitForURL(new RegExp(`/staff/${tenant.slug}/contract-templates$`));
    expect(await templateCount()).toBe(before);
  });

  const bouprod = process.env.FLUX_BOUPROD_DOCX;
  test("the BOUPROD Word agreement converts with every clause and can be created as a draft (test business only)", async () => {
    test.skip(!bouprod || !existsSync(bouprod), "set FLUX_BOUPROD_DOCX to the agreement's local path");
    await staff.goto(`/staff/${tenant.slug}/contract-templates/new?start=import`);
    await upload(staff, "Boukine Productions Contract - Template.docx", readFileSync(bouprod!));
    await staff.getByRole("button", { name: "Convert document" }).click();
    await expect(staff.getByRole("heading", { name: "Review the import" })).toBeVisible();
    await expect(staff.getByTestId("import-stats")).toContainText("Sections10");
    const previewed = staff.getByTestId("import-preview");
    await expect(previewed.getByRole("heading")).toHaveText([
      "DJ/AV SERVICE AGREEMENT",
      "Introduction",
      "1. Equipment and Setup:",
      "2. Cancellation Policy:",
      "3. Performance Schedule:",
      "4. Replacement DJ:",
      "5. Equipment Liability:",
      "6. Payment Terms:",
      "7. Force Majeure:",
      "8. Music Selection & Requests:",
      "Acceptance of Agreement:",
    ]);
    await expect(staff.getByTestId("issue-missing")).toHaveCount(0);
    await expect(staff.getByTestId("issue-duplicates")).toContainText("Signature lines");
    // The review fits a phone width too.
    await staff.setViewportSize({ width: 390, height: 844 });
    expect(await noSideways(staff)).toBeLessThanOrEqual(0);
    await staff.setViewportSize({ width: 1280, height: 800 });
    for (const box of await staff.getByTestId("import-review").getByRole("checkbox", { name: /I've checked this|Use these as fields/ }).all()) await box.check();
    await staff.getByRole("button", { name: "Create draft" }).click();
    await staff.waitForURL(/\/contract-templates\/[0-9a-f-]{36}\?created=1$/);
    const templateId = new URL(staff.url()).pathname.split("/").pop()!;
    const { data: version } = await admin.from("contract_template_versions").select("title, sections").eq("template_id", templateId).single();
    expect(version!.title).toBe("DJ/AV SERVICE AGREEMENT");
    expect((version!.sections as { heading: string }[]).map((s) => s.heading)).toHaveLength(10);
  });
});
