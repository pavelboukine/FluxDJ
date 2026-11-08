/**
 * Logo size, measured in the real header at real widths: a square logo gets bigger, a
 * wide one stays inside its width limit, the 56px bar never grows, and the aspect ratio
 * holds. Generated logos only. What each save freezes is covered by branding-flow.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { paddedDiscPng, transparentPng, whiteOnTransparentPng } from "../support/logo-fixtures";

const run = randomUUID().slice(0, 6);
const WIDTHS = [{ width: 1280, height: 900 }, { width: 1024, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 720 }];
const brand = (page: Page) => page.getByTestId("workspace-brand").getByRole("img");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = async (locator: Locator) => (await locator.boundingBox())!;
const loaded = (image: Locator) => expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

/** The header's height is fixed and everything visible stays inside it, at this width. */
async function expectFitsHeader(page: Page) {
  const image = brand(page);
  await loaded(image);
  const bar = await box(page.locator("header").first());
  expect(bar.height).toBeLessThanOrEqual(57); // 56px and its border
  const plate = await box(image.locator("xpath=.."));
  expect(plate.y).toBeGreaterThanOrEqual(bar.y);
  expect(plate.y + plate.height).toBeLessThanOrEqual(bar.y + bar.height);
  const logo = await box(image);
  expect(logo.x).toBeGreaterThanOrEqual(0);
  expect(logo.x + logo.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
}
async function expectRatioKept(image: Locator) {
  await loaded(image);
  const { w, h } = await image.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  const shown = await box(image);
  expect(shown.width / shown.height).toBeCloseTo(w / h, 0);
}

test.describe.serial("logo size", () => {
  let browser: Browser;
  let square: TestTenant;
  let wide: TestTenant;
  let light: TestTenant;
  const staffEmail = `e2e-logo-size-staff-${run}@example.test`;
  const files: Record<string, string> = {};

  async function ownerPage(tenant: TestTenant, viewport = WIDTHS[0]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await signInStaff(page, tenant.ownerEmail);
    return page;
  }
  async function upload(page: Page, tenant: TestTenant, file: string, size?: string) {
    await page.goto(`/staff/${tenant.slug}/settings/branding`);
    await page.getByLabel("Logo", { exact: true }).setInputFiles(file);
    if (size) await page.getByRole("slider", { name: "Logo size" }).fill(size);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    await expect(brand(page)).toBeVisible();
  }

  test.beforeAll(async ({ browser: b }, info) => {
    browser = b;
    [square, wide, light] = await Promise.all([createTestTenant("logo-square"), createTestTenant("logo-wide"), createTestTenant("logo-light")]);
    const { data: staffUser, error } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    if (error) throw error;
    const { error: memberError } = await admin.from("tenant_memberships").insert({ tenant_id: square.id, user_id: staffUser.user!.id, role: "staff" });
    if (memberError) throw memberError;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries({
      "square.png": await paddedDiscPng(1600, 400),
      "wide.png": await transparentPng(3200, 300),
      "light.png": await whiteOnTransparentPng(800, 800),
    })) {
      files[name] = join(dir, name);
      writeFileSync(files[name], bytes);
    }
  });

  test.afterAll(async () => {
    for (const tenant of [square, wide, light]) await archiveTestTenant(tenant);
  });

  test("a square logo keeps today's size by default, its margin trimmed, and grows only when the owner saves a larger size", async () => {
    const page = await ownerPage(square);
    await page.goto(`/staff/${square.slug}/settings/branding`);
    await expect(page.getByRole("slider", { name: "Logo size" })).toHaveCount(0); // no logo yet

    // Before saving, the preview already shows the logo as the save will store it: the same processing, margin trimmed.
    await page.getByLabel("Logo", { exact: true }).setInputFiles(files["square.png"]);
    await expect(page.getByTestId("logo-preview-state")).toHaveText("The preview shows the logo as it will be saved.");
    const chosenPreview = page.getByTestId("header-preview").getByRole("img", { name: square.displayName });
    await expect(chosenPreview).toHaveAttribute("src", /^data:image\/png;base64,/);
    await loaded(chosenPreview);
    const previewed = await chosenPreview.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    expect((await admin.from("tenant_logos").select("id").eq("tenant_id", square.id)).data).toEqual([]); // nothing stored yet
    await upload(page, square, files["square.png"]);
    await expectRatioKept(brand(page));
    expect((await box(brand(page))).height).toBeCloseTo(36, 0);
    await expect(page.getByTestId("logo-size-value")).toHaveText("Default");
    // The 400px margin on a 1600px canvas is gone: the stored logo is only the disc.
    const { data } = await admin.from("tenant_logos").select("width, height").eq("tenant_id", square.id).order("created_at", { ascending: false }).limit(1).single();
    expect(data!.width).toBeLessThanOrEqual(1024);
    expect(Math.abs(data!.width - data!.height)).toBeLessThanOrEqual(1);
    expect(data!.width).toBeGreaterThanOrEqual(505);
    expect(previewed).toEqual({ w: data!.width, h: data!.height }); // what was previewed is what was saved

    // Moving the slider changes the previews at once, and only them.
    const previewLogo = page.getByTestId("header-preview").getByRole("img", { name: square.displayName });
    await loaded(previewLogo);
    expect((await box(previewLogo)).height).toBeCloseTo(36, 0);
    const clientLogo = page.getByTestId("client-preview").getByRole("img", { name: square.displayName });
    expect((await box(clientLogo)).height).toBeCloseTo(36, 0);
    await page.getByRole("slider", { name: "Logo size" }).fill("130");
    await expect(page.getByTestId("logo-size-value")).toHaveText("130%");
    await expect.poll(async () => Math.round((await box(previewLogo)).height)).toBe(47);
    expect(Math.round((await box(clientLogo)).height)).toBe(47);
    expect((await box(brand(page))).height).toBeCloseTo(36, 0);
    const previewBar = await box(page.getByTestId("header-preview"));
    expect(previewBar.height).toBeLessThanOrEqual(57);

    // Undoing it leaves nothing unsaved; keeping it does.
    const form = page.locator("form").filter({ has: page.getByLabel("Logo", { exact: true }) });
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await page.getByRole("slider", { name: "Logo size" }).fill("100");
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);

    await page.getByRole("slider", { name: "Logo size" }).fill("130");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    await expect(form.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
    await expect.poll(async () => Math.round((await box(brand(page))).height)).toBe(47);
    await expect(page.getByRole("slider", { name: "Logo size" })).toHaveValue("130");
    expect((await admin.from("tenants").select("logo_size_percent").eq("id", square.id).single()).data!.logo_size_percent).toBe(130);
    await page.reload();
    await expect(page.getByRole("slider", { name: "Logo size" })).toHaveValue("130");
    await page.context().close();
  });

  test("square, at the largest size: fits the header at every width, with no sideways scrolling", async () => {
    const page = await ownerPage(square);
    for (const viewport of WIDTHS) {
      await page.setViewportSize(viewport);
      for (const path of ["", "/settings/branding"]) {
        await page.goto(`/staff/${square.slug}${path}`);
        await expectFitsHeader(page);
        await expectRatioKept(brand(page));
      }
      expect(Math.round((await box(brand(page))).height)).toBe(viewport.width >= 1024 ? 47 : 42);
    }
    await page.context().close();
  });

  test("a wide logo stops at its width limit instead of overflowing", async () => {
    const page = await ownerPage(wide);
    await upload(page, wide, files["wide.png"], "130");
    for (const viewport of WIDTHS) {
      await page.setViewportSize(viewport);
      await page.goto(`/staff/${wide.slug}`);
      await expectFitsHeader(page);
      await expectRatioKept(brand(page));
      const limit = viewport.width >= 1024 ? 288 : viewport.width >= 640 ? viewport.width - 320 : viewport.width - 256;
      expect((await box(brand(page))).width).toBeLessThanOrEqual(limit + 1);
    }
    await page.context().close();
  });

  test("a light logo's dark plate stays inside the header at the largest size", async () => {
    const page = await ownerPage(light);
    // The preview knows a light logo needs its dark plate before it is saved.
    await page.goto(`/staff/${light.slug}/settings/branding`);
    await page.getByLabel("Logo", { exact: true }).setInputFiles(files["light.png"]);
    await expect(page.getByTestId("logo-preview-state")).toHaveText("The preview shows the logo as it will be saved.");
    await expect(page.getByTestId("header-preview").getByRole("img", { name: light.displayName }).locator("xpath=..")).toHaveClass(/bg-neutral-900/);
    await upload(page, light, files["light.png"], "130");
    for (const viewport of WIDTHS) {
      await page.setViewportSize(viewport);
      await page.goto(`/staff/${light.slug}`);
      await expectFitsHeader(page);
    }
    await page.context().close();
  });

  test("the slider appears only with a logo, and removing a logo keeps the size for the next one", async () => {
    const page = await ownerPage(light);
    await page.goto(`/staff/${light.slug}/settings/branding`);
    await page.getByRole("checkbox", { name: /Remove the logo/ }).check();
    await expect(page.getByRole("slider", { name: "Logo size" })).toHaveCount(0);
    await expect(page.getByTestId("header-preview")).toContainText(light.displayName);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    expect((await admin.from("tenants").select("logo_size_percent, logo_storage_path").eq("id", light.id).single()).data).toEqual({ logo_size_percent: 130, logo_storage_path: null });
    await page.context().close();
  });

  test("staff see the size read-only, in the header too, and can't set it", async () => {
    const staff = await (await browser.newContext({ viewport: WIDTHS[0] })).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${square.slug}/settings/branding`);
    await expect(staff.getByText("Only the owner can change branding.")).toBeVisible();
    await expect(staff.getByRole("slider", { name: "Logo size" })).toHaveCount(0);
    await expect(staff.getByRole("main")).toContainText("130%");
    await loaded(brand(staff));
    expect(Math.round((await box(brand(staff))).height)).toBe(47);
    await staff.context().close();
  });
});
