/**
 * Logo variants in a real browser, on a phone, with generated logo files (never a real business's
 * logo) in a dedicated test business: the owner makes a white version of a single-colour logo, a
 * client's proposal shows it on the dark header, the owner replaces and removes it, the sent
 * proposal keeps the one it was sent with, and a multicolour logo is never offered a white version.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, pageScheme, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { paddedDiscPng, twoColourPng, whiteOnTransparentPng } from "../support/logo-fixtures";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-variant-client-${run}@example.test`;
const PHONE = { width: 390, height: 844 };
const files: Record<string, string> = {};
const logoPathOf = (src: string | null) => /tenant-logos\/([^?]+)/.exec(src ?? "")?.[1];
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.serial("logo for dark backgrounds", () => {
  let browser: Browser;
  let t: TestTenant;
  let owner: Page;
  let client: Page;
  let eventId = "";
  let frozenVariant = "";

  const saved = async () => (await admin.from("tenants").select("logo_storage_path, logo_on_dark_storage_path").eq("id", t.id).single()).data!;
  const save = async () => {
    await owner.getByRole("button", { name: "Save changes" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
  };
  const darkSection = () => owner.getByTestId("logo-on-dark");
  const openDarkSection = async () => {
    if (!(await darkSection().evaluate((d) => (d as HTMLDetailsElement).open))) await darkSection().locator("summary").click();
  };

  test.beforeAll(async ({ browser: br }, info) => {
    browser = br;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, bytes: Buffer) => writeFileSync((files[name] = join(dir, name)), bytes);
    write("black-disc.png", await paddedDiscPng(400, 40, [17, 17, 17]));
    write("white.png", await whiteOnTransparentPng(800, 200));
    write("two-colour.png", await twoColourPng());

    t = await createTestTenant("variant", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: t.id, name: "Jo & Lee", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: t.id, title: `E2E Variant Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14" });
    await admin.from("event_clients").insert({ tenant_id: t.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    owner = await (await browser.newContext({ viewport: PHONE })).newPage();
    await signInStaff(owner, t.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(t);
  });

  test("the owner makes a white version of a single-colour logo, previewed before saving", async () => {
    await owner.goto(`/staff/${t.slug}/settings/branding`);
    await expect(darkSection()).toHaveCount(0); // only once there is a logo
    await owner.getByLabel("Logo", { exact: true }).setInputFiles(files["black-disc.png"]);
    await expect(owner.getByTestId("logo-preview-state")).toHaveText("The preview shows the logo as it will be saved.");
    await openDarkSection();
    await expect(darkSection()).toContainText("Without one, a dark logo sits on a small white panel there.");
    // Without a variant the dark sample shows the logo readable on a white panel.
    const sample = owner.getByTestId("logo-on-dark-current").getByRole("img", { name: t.displayName });
    await expect(sample.locator("xpath=..")).toHaveCSS("background-color", "rgb(255, 255, 255)");

    const white = owner.getByLabel("Create a white version of my logo");
    await white.check();
    await expect(owner.getByTestId("logo-on-dark-state")).toContainText("only the colour becomes white. Your logo itself isn't changed.");
    await expect(sample.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(sample).toHaveCSS("filter", "brightness(0) invert(1)");
    // The proposal preview's header (the test business's dark grey) shows it too; the event page keeps the logo.
    const hero = owner.getByTestId("preview-hero").getByRole("img", { name: t.displayName });
    await expect(hero).toHaveCSS("filter", "brightness(0) invert(1)");
    expect(await noSideScroll(owner)).toBeLessThanOrEqual(0);

    await save();
    const after = await saved();
    expect(after.logo_on_dark_storage_path).toMatch(new RegExp(`^${t.id}/logos/`));
    expect(after.logo_on_dark_storage_path).not.toBe(after.logo_storage_path);
    // The stored file is white where the logo is visible, and the original is untouched.
    const pixels = async (path: string) => {
      const { data } = await admin.storage.from("tenant-logos").download(path);
      return sharp(Buffer.from(await data!.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    };
    const [variant, original] = [await pixels(after.logo_on_dark_storage_path!), await pixels(after.logo_storage_path!)];
    expect([variant.info.width, variant.info.height]).toEqual([original.info.width, original.info.height]);
    const centre = ((original.info.height >> 1) * original.info.width + (original.info.width >> 1)) * 4;
    expect([...variant.data.subarray(centre, centre + 4)]).toEqual([255, 255, 255, 255]);
    expect([...original.data.subarray(centre, centre + 4)]).toEqual([17, 17, 17, 255]);
    // Saved: the section reports it and offers replacing or removing it; the logo itself is the default upload as before.
    const expectSavedState = async () => {
      await expect(owner.getByTestId("logo-on-dark-value")).toHaveText("Added");
      await expect(owner.getByTestId("logo-on-dark-saved")).toHaveText("Logo for dark backgrounds added. Choose a file above to replace it, or remove it.");
      await expect(owner.getByLabel(/Create a white version/)).toHaveCount(0); // never an unchecked box that reads as "off"
      await expect(owner.getByLabel("Remove the logo for dark backgrounds")).not.toBeChecked();
      await expect(owner.getByLabel("Logo for dark backgrounds", { exact: true })).toBeVisible();
    };
    await expectSavedState();

    // After a reload too: the section opens on the saved logo, and the proposal preview's dark header shows that file.
    await owner.reload();
    await expect(darkSection()).toHaveJSProperty("open", true);
    await expectSavedState();
    const savedHero = owner.getByTestId("preview-hero").getByRole("img", { name: t.displayName });
    expect(logoPathOf(await savedHero.getAttribute("src"))).toBe(after.logo_on_dark_storage_path);
    await expect(savedHero).toHaveCSS("filter", "none");
    await expect(owner.getByTestId("logo-on-dark-current").getByRole("img", { name: t.displayName })).toHaveCSS("filter", "none");

    // An unrelated change saves without making the white version again, and nothing new is stored.
    const logoCount = async () => (await admin.from("tenant_logos").select("id", { count: "exact", head: true }).eq("tenant_id", t.id)).count;
    const stored = await logoCount();
    const colour = owner.getByLabel("Primary colour", { exact: true });
    const originalColour = await colour.inputValue();
    await colour.fill("#1e3a8a");
    await save();
    expect(await saved()).toEqual(after);
    expect(await logoCount()).toBe(stored);
    // Even a request for the white version again (a tab still showing the old box, say) keeps the saved file.
    await owner.evaluate(() => {
      const box = document.createElement("input");
      Object.assign(box, { type: "checkbox", name: "logo_on_dark_white", checked: true, hidden: true });
      document.querySelector("form")!.appendChild(box);
    });
    await colour.fill(originalColour);
    await save();
    expect(await saved()).toEqual(after);
    expect(await logoCount()).toBe(stored);
    await owner.reload();
    await expectSavedState();
  });

  test("a client's proposal shows it on the dark header without a panel; light pages keep the logo", async () => {
    const sentAt = Date.now();
    await sendProposalFromEventPage(owner, t, eventId);
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    client = await (await browser.newContext({ viewport: PHONE })).newPage();
    await client.goto(/(http:\/\/\S+\/p#\S+)/.exec(email.text)![1]);
    await client.waitForURL("**/proposals/**");
    const { logo_on_dark_storage_path: variant, logo_storage_path: main } = await saved();
    frozenVariant = variant!;
    const heroLogo = client.getByTestId("proposal-hero").getByRole("img", { name: t.displayName });
    await expect(heroLogo).toBeVisible();
    expect(logoPathOf(await heroLogo.getAttribute("src"))).toBe(variant);
    await expect(heroLogo.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(heroLogo).toHaveCSS("filter", "none"); // a real file, never recoloured in the browser
    expect(await noSideScroll(client)).toBeLessThanOrEqual(0);

    // The staff workspace header follows the staff theme: the logo itself in light, the version for dark
    // backgrounds in dark.
    const header = owner.getByTestId("workspace-brand").getByRole("img", { name: t.displayName });
    expect(logoPathOf(await header.getAttribute("src"))).toBe((await pageScheme(owner)) === "dark" ? variant : main);
  });

  test("the owner replaces and then removes it; the sent proposal keeps the one it was sent with", async () => {
    await owner.goto(`/staff/${t.slug}/settings/branding`);
    await openDarkSection();
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles(files["white.png"]);
    await expect(owner.getByTestId("logo-on-dark-state")).toHaveText("The preview shows the logo as it will be saved.");
    await expect(owner.getByLabel(/Create a white version/)).toHaveCount(0);
    await save();
    const replaced = (await saved()).logo_on_dark_storage_path;
    expect(replaced).not.toBe(frozenVariant);
    // An uploaded file is reported the same neutral way: never as one Flux made.
    await expect(owner.getByTestId("logo-on-dark-saved")).toHaveText("Logo for dark backgrounds added. Choose a file above to replace it, or remove it.");
    await expect(owner.getByTestId("logo-on-dark-value")).toHaveText("Added");
    await expect(darkSection()).not.toContainText(/made from your logo|white version/i);

    // A new main logo with the dark one kept: a warning beside the logo, and both logos stay unless the owner chooses.
    const form = owner.locator("form").filter({ has: owner.getByLabel("Logo", { exact: true }) });
    const mismatch = owner.getByTestId("logo-variant-mismatch");
    const removeDark = owner.getByLabel("Remove the logo for dark backgrounds");
    await expect(mismatch).toHaveCount(0);
    await owner.getByLabel("Logo", { exact: true }).setInputFiles(files["two-colour.png"]);
    await expect(mismatch).toContainText("may no longer match the new logo. Replace or remove it below.");
    await expect(removeDark).toBeVisible(); // the section is open to act on it
    await removeDark.check();
    await expect(mismatch).toHaveCount(0);
    await removeDark.uncheck();
    await expect(mismatch).toBeVisible();
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles(files["white.png"]);
    await expect(mismatch).toHaveCount(0);
    // Back to the saved state: nothing left to warn about or save.
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles([]);
    await expect(mismatch).toBeVisible();
    await owner.getByLabel("Logo", { exact: true }).setInputFiles([]);
    await expect(mismatch).toHaveCount(0);
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
    // A new single-colour logo: the warning also offers a white version of it, which resolves the mismatch.
    await owner.getByLabel("Logo", { exact: true }).setInputFiles(files["black-disc.png"]);
    await expect(mismatch).toContainText("Replace or remove it below, or create a white version of the new logo.");
    await expect(owner.getByTestId("logo-on-dark-saved")).toBeVisible();
    const whiteOfNew = owner.getByLabel("Create a white version of the new logo");
    await whiteOfNew.check();
    await expect(mismatch).toHaveCount(0);
    await expect(owner.getByTestId("logo-on-dark-saved")).toHaveCount(0);
    await expect(owner.getByTestId("logo-on-dark-value")).toHaveText("White version");
    await expect(removeDark).toHaveCount(0);
    await whiteOfNew.uncheck();
    await expect(mismatch).toBeVisible();
    await owner.getByLabel("Logo", { exact: true }).setInputFiles([]);
    await expect(mismatch).toHaveCount(0);
    await expect(owner.getByLabel(/Create a white version/)).toHaveCount(0);
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
    // Choosing only a logo for dark backgrounds is an unsaved change.
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles(files["white.png"]);
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles([]);
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
    expect((await saved()).logo_on_dark_storage_path).toBe(replaced);

    await openDarkSection();
    await removeDark.check();
    await save();
    expect(await saved()).toMatchObject({ logo_on_dark_storage_path: null });
    expect((await saved()).logo_storage_path).toMatch(new RegExp(`^${t.id}/logos/`));

    await client.reload();
    const heroLogo = client.getByTestId("proposal-hero").getByRole("img", { name: t.displayName });
    expect(logoPathOf(await heroLogo.getAttribute("src"))).toBe(frozenVariant);
    await client.context().close();

    // A proposal sent now has one logo: on this business's solid dark-grey header the dark logo gets a compact white panel.
    const [laterEvent, laterClient, laterEmail] = [randomUUID(), randomUUID(), `e2e-variant-later-${run}@example.test`];
    await admin.from("clients").insert({ id: laterClient, tenant_id: t.id, name: "Kim & Ari", email: laterEmail });
    await admin.from("events").insert({ id: laterEvent, tenant_id: t.id, title: `E2E Single Logo ${run}`, event_type: "wedding", event_date: "2027-09-04" });
    await admin.from("event_clients").insert({ tenant_id: t.id, event_id: laterEvent, client_id: laterClient, is_primary: true, can_sign: true });
    const sentAt = Date.now();
    await sendProposalFromEventPage(owner, t, laterEvent);
    const email = await waitForEmail(laterEmail, { after: sentAt, subject: /sent you a proposal/ });
    const later = await (await browser.newContext({ viewport: PHONE })).newPage();
    await later.goto(/(http:\/\/\S+\/p#\S+)/.exec(email.text)![1]);
    await later.waitForURL("**/proposals/**");
    const single = later.getByTestId("proposal-hero").getByRole("img", { name: t.displayName });
    await expect(single).toBeVisible();
    expect(logoPathOf(await single.getAttribute("src"))).toBe((await saved()).logo_storage_path);
    await expect(single.locator("xpath=..")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await noSideScroll(later)).toBeLessThanOrEqual(0);
    await later.context().close();
  });

  test("a multicolour logo is never offered a white version, and a dark upload is flagged", async () => {
    await owner.goto(`/staff/${t.slug}/settings/branding`);
    await owner.getByLabel("Logo", { exact: true }).setInputFiles(files["two-colour.png"]);
    await expect(owner.getByTestId("logo-preview-state")).toHaveText("The preview shows the logo as it will be saved.");
    await openDarkSection();
    await expect(owner.getByLabel(/Create a white version/)).toHaveCount(0);
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles(files["black-disc.png"]);
    await expect(owner.getByTestId("logo-on-dark-state")).toContainText("This logo looks dark");
    // A forged request for a white version of this logo is refused, and nothing changes.
    await owner.getByLabel("Logo for dark backgrounds", { exact: true }).setInputFiles([]);
    await owner.evaluate(() => {
      const box = document.createElement("input");
      Object.assign(box, { type: "checkbox", name: "logo_on_dark_white", checked: true, hidden: true });
      document.querySelector("form")!.appendChild(box);
    });
    const before = await saved();
    await owner.getByRole("button", { name: "Save changes" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "A white version can only be made from a single-colour logo" })).toBeVisible();
    expect(await saved()).toEqual(before);
  });
});
