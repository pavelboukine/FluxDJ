/**
 * Business branding in real browsers with generated logo files (never a real
 * business's logo), in dedicated test businesses: owner uploads, previews and
 * saves; refusals; stale tabs; a second business; staff; and a client's sent
 * proposal keeping its logo after a replacement.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, sendProposalFromEventPage, type TestTenant } from "./tenant";
import { htmlDisguisedAsPng, opaqueJpeg, transparentPng, whiteOnTransparentPng } from "../support/logo-fixtures";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-brand-client-${run}@example.test`;
const PHONE = { width: 390, height: 844 };
const files: Record<string, string> = {};

async function chooseLogo(page: Page, file: string) {
  await page.getByLabel("Logo", { exact: true }).setInputFiles(file);
}
const headerLogo = (page: Page, name: string) => page.getByTestId("workspace-brand").getByRole("img", { name });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const logoPathOf = (src: string | null) => /tenant-logos\/([^?]+)/.exec(src ?? "")?.[1];

test.describe.serial("business branding", () => {
  let browser: Browser;
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: Page;
  let eventId = "";

  test.beforeAll(async ({ browser: br }, info) => {
    browser = br;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    const write = (name: string, bytes: Buffer) => writeFileSync((files[name] = join(dir, name)), bytes);
    write("wide.png", await transparentPng(1600, 400));
    write("light.png", await whiteOnTransparentPng(800, 200));
    write("tall.jpg", await opaqueJpeg(300, 900));
    write("disguised.png", htmlDisguisedAsPng());
    write("huge.png", Buffer.concat([await transparentPng(100, 100), Buffer.alloc(5 * 1024 * 1024)]));

    a = await createTestTenant("brand-a", { catalog: true });
    b = await createTestTenant("brand-b");
    eventId = randomUUID();
    const clientId = randomUUID();
    await admin.from("clients").insert({ id: clientId, tenant_id: a.id, name: "Jo & Lee", email: clientEmail });
    await admin.from("events").insert({ id: eventId, tenant_id: a.id, title: `E2E Branding Wedding ${run}`, event_type: "wedding", event_date: "2027-08-14" });
    await admin.from("event_clients").insert({ tenant_id: a.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
    ownerA = await (await browser.newContext({ viewport: PHONE })).newPage();
    await signInStaff(ownerA, a.ownerEmail);
  });

  test.afterAll(async () => {
    await archiveTestTenant(a);
    await archiveTestTenant(b);
  });

  test("the owner previews a logo and a light colour, saves, and the header shows the logo", async () => {
    await ownerA.goto(`/staff/${a.slug}/settings#branding`);
    await expect(headerLogo(ownerA, a.displayName)).toHaveCount(0); // the name until a logo exists
    const preview = ownerA.getByTestId("branding-preview");
    await expect(preview).toContainText("Preview · not saved, nothing is sent");
    await chooseLogo(ownerA, files["wide.png"]);
    await expect(preview.getByRole("img", { name: a.displayName })).toBeVisible();
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#ffff00");
    await expect(ownerA.getByTestId("contrast-note")).toContainText("Button text on this colour: dark");
    await expect(preview.getByText("Submit my selection")).toHaveCSS("color", "rgb(0, 0, 0)");
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);

    await ownerA.getByRole("button", { name: "Save branding" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    const logo = headerLogo(ownerA, a.displayName);
    await expect(logo).toBeVisible();
    const box = (await logo.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(32.5);
    expect(box.width / box.height).toBeCloseTo(4, 0); // 1600 x 400: not stretched or cropped
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);
    const { data } = await admin.from("tenants").select("brand_colors, logo_storage_path, branding_version").eq("id", a.id).single();
    expect(data).toMatchObject({ branding_version: 1, brand_colors: { primary: "#ffff00" } });
    expect(data!.logo_storage_path).toMatch(new RegExp(`^${a.id}/logos/`));
  });

  test("a client's proposal shows the logo it was sent with, even after the owner replaces it", async () => {
    const sentAt = Date.now();
    await sendProposalFromEventPage(ownerA, a, eventId);
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    const client = await (await browser.newContext({ viewport: PHONE })).newPage();
    await client.goto(/(http:\/\/\S+\/p#\S+)/.exec(email.text)![1]);
    await client.waitForURL("**/proposals/**");
    const sentLogo = client.getByRole("img", { name: a.displayName }).first();
    await expect(sentLogo).toBeVisible();
    const sentPath = logoPathOf(await sentLogo.getAttribute("src"));
    await expect(client.locator("header").first()).toHaveCSS("color", "rgb(0, 0, 0)"); // readable on yellow

    // The owner replaces the logo with light artwork and a dark colour.
    await ownerA.goto(`/staff/${a.slug}/settings#branding`);
    await chooseLogo(ownerA, files["light.png"]);
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#1e3a8a");
    await ownerA.getByRole("button", { name: "Save branding" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    // Light artwork sits on a dark backdrop in the header.
    await expect(headerLogo(ownerA, a.displayName).locator("xpath=..")).toHaveClass(/bg-neutral-900/);
    expect(logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"))).not.toBe(sentPath);

    await client.reload();
    expect(logoPathOf(await client.getByRole("img", { name: a.displayName }).first().getAttribute("src"))).toBe(sentPath);
    await client.context().close();
  });

  test("disguised and oversized files are refused and the current logo stays", async () => {
    await ownerA.goto(`/staff/${a.slug}/settings#branding`);
    const before = logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"));
    await chooseLogo(ownerA, files["huge.png"]);
    await expect(ownerA.getByRole("alert").filter({ hasText: "The logo must be 4 MB or smaller." })).toBeVisible();
    await chooseLogo(ownerA, files["disguised.png"]);
    await ownerA.getByRole("button", { name: "Save branding" }).click();
    await expect(ownerA.getByRole("alert").filter({ hasText: "isn't a PNG, JPEG or WebP image" })).toContainText("Your current logo is unchanged.");
    await ownerA.reload();
    expect(logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"))).toBe(before);
  });

  test("a stale tab can't overwrite newer branding, and keeps what was typed", async () => {
    const stale = await ownerA.context().newPage();
    await stale.goto(`/staff/${a.slug}/settings#branding`);
    await ownerA.goto(`/staff/${a.slug}/settings#branding`);
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#0f766e");
    await ownerA.getByRole("button", { name: "Save branding" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();

    await stale.getByLabel("Primary colour", { exact: true }).fill("#7c3aed");
    await stale.getByRole("button", { name: "Save branding" }).click();
    await expect(stale.getByRole("alert").filter({ hasText: "Someone else saved changes first" })).toBeVisible();
    await expect(stale.getByLabel("Primary colour", { exact: true })).toHaveValue("#7c3aed");
    const { data } = await admin.from("tenants").select("brand_colors").eq("id", a.id).single();
    expect(data!.brand_colors).toMatchObject({ primary: "#0f766e" });
    await stale.close();
  });

  test("another business shows its own logo; staff can only view branding", async () => {
    const ownerB = await (await browser.newContext({ viewport: PHONE })).newPage();
    await signInStaff(ownerB, b.ownerEmail);
    await ownerB.goto(`/staff/${b.slug}/settings#branding`);
    await chooseLogo(ownerB, files["tall.jpg"]);
    await ownerB.getByRole("button", { name: "Save branding" }).click();
    await expect(ownerB.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    const logoB = headerLogo(ownerB, b.displayName);
    const box = (await logoB.boundingBox())!;
    expect(box.height / box.width).toBeCloseTo(3, 0); // 300 x 900, contained
    expect(logoPathOf(await logoB.getAttribute("src"))).toMatch(new RegExp(`^${b.id}/`));
    await ownerB.goto(`/staff/${a.slug}`);
    await expect(ownerB.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await ownerB.context().close();

    const staffEmail = `e2e-brand-staff-${run}@example.test`;
    const { data: user } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    await admin.from("tenant_memberships").insert({ tenant_id: a.id, user_id: user.user!.id, role: "staff" });
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${a.slug}/settings#branding`);
    await expect(staff.getByText("Only the owner can change branding.")).toBeVisible();
    await expect(staff.getByLabel("Logo", { exact: true })).toHaveCount(0);
    await expect(headerLogo(staff, a.displayName)).toBeVisible();
    await staff.context().close();
  });
});
