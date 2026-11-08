/**
 * Unsaved edits on the settings pages and the separate deposit and legal saves.
 * Links ask first (once, for any number of edited forms) and closing or reloading
 * the tab asks through the browser. Browser Back deliberately isn't covered: Next.js
 * has no supported way to stop it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Dialog, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { transparentPng } from "../support/logo-fixtures";

const run = randomUUID().slice(0, 6);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const UNSAVED = "You have unsaved changes";

/** Records every dialog and answers with `answer` (the test changes it as it goes). */
function dialogs(page: Page) {
  const seen = { confirms: 0, unloads: 0, accept: false };
  page.on("dialog", (dialog: Dialog) => {
    if (dialog.type() === "beforeunload") seen.unloads += 1;
    else {
      expect(dialog.message()).toContain(UNSAVED);
      seen.confirms += 1;
    }
    void (seen.accept ? dialog.accept() : dialog.dismiss());
  });
  return seen;
}
const unsaved = (region: ReturnType<Page["getByRole"]>) => region.getByRole("status").filter({ hasText: "Unsaved changes" });
const save = (region: ReturnType<Page["getByRole"]>) => region.getByRole("button", { name: "Save changes" });
const legalRow = async (tenant: TestTenant) =>
  (await admin.from("tenants").select("business_name, business_address, contact_email, deposit_percent").eq("id", tenant.id).single()).data!;

test.describe.serial("unsaved settings and separate saves", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let fresh: TestTenant;
  let other: TestTenant;
  let page: Page;
  let seen: ReturnType<typeof dialogs>;
  const staffEmail = `e2e-settings-unsaved-staff-${run}@example.test`;
  let logoFile: string;

  test.beforeAll(async ({ browser: b }, info) => {
    browser = b;
    tenant = await createTestTenant("settings-unsaved");
    other = await createTestTenant("settings-unsaved-other");
    fresh = await createTestTenant("settings-unsaved-new");
    const { error } = await admin.from("tenants").update({ business_address: null, contact_email: null }).eq("id", fresh.id);
    if (error) throw error;
    const { data: staffUser, error: userError } = await admin.auth.admin.createUser({ email: staffEmail, email_confirm: true });
    if (userError) throw userError;
    const { error: memberError } = await admin.from("tenant_memberships").insert({ tenant_id: tenant.id, user_id: staffUser.user!.id, role: "staff" });
    if (memberError) throw memberError;
    const dir = info.outputPath("logos");
    mkdirSync(dir, { recursive: true });
    logoFile = join(dir, "logo.png");
    writeFileSync(logoFile, await transparentPng(1600, 1200));
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    seen = dialogs(page);
    await signInStaff(page, tenant.ownerEmail);
  });

  test.afterAll(async () => {
    await page?.context().close();
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
    await archiveTestTenant(fresh);
  });

  test("two edited forms: a link asks once, staying keeps both, and each save clears only its own form", async () => {
    await page.goto(`/staff/${tenant.slug}/settings/profile`);
    const contract = page.getByRole("region", { name: "Contract details" });
    const replies = page.getByRole("region", { name: "Replies and notifications" });
    const nav = page.getByRole("navigation", { name: "Settings" });
    const legal = page.getByLabel("Legal business name");
    const replyTo = page.getByLabel("Reply-to email");

    // Nothing edited: links just go.
    await nav.getByRole("link", { name: "Branding" }).click();
    await page.waitForURL("**/settings/branding");
    await nav.getByRole("link", { name: "Business profile" }).click();
    await page.waitForURL("**/settings/profile");
    expect(seen.confirms).toBe(0);

    await legal.fill(`Legal ${run}`);
    await replyTo.fill(`replies-${run}@example.test`);
    await expect(unsaved(contract)).toBeVisible();
    await expect(unsaved(replies)).toBeVisible();

    // Stay: same page, nothing lost, one question for two edited forms.
    await nav.getByRole("link", { name: "Bookings" }).click();
    await expect.poll(() => seen.confirms).toBe(1);
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(legal).toHaveValue(`Legal ${run}`);
    await expect(replyTo).toHaveValue(`replies-${run}@example.test`);

    // The main sidebar and the wordmark ask too.
    await page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Events" }).click();
    await expect.poll(() => seen.confirms).toBe(2);
    await page.getByRole("link", { name: "Flux DJ home" }).click();
    await expect.poll(() => seen.confirms).toBe(3);
    await expect(legal).toHaveValue(`Legal ${run}`);

    // Saving one leaves the other still protected.
    await save(contract).click();
    await expect(contract.getByText(/Settings saved/)).toBeVisible();
    await expect(unsaved(contract)).toHaveCount(0);
    await expect(unsaved(replies)).toBeVisible();
    await nav.getByRole("link", { name: "Bookings" }).click();
    await expect.poll(() => seen.confirms).toBe(4);
    await expect(page).toHaveURL(/\/settings\/profile$/);

    // Saving the other: nothing left to ask about.
    await save(replies).click();
    await expect(replies.getByRole("status").filter({ hasText: "now go to" })).toBeVisible();
    await expect(unsaved(replies)).toHaveCount(0);
    await nav.getByRole("link", { name: "Bookings" }).click();
    await page.waitForURL("**/settings/bookings");
    expect(seen.confirms).toBe(4);
  });

  test("choosing to leave goes through with one question; undoing an edit needs none", async () => {
    await page.goto(`/staff/${tenant.slug}/settings/planning`);
    const days = page.getByLabel("Days before the event");
    const original = await days.inputValue();
    const nav = page.getByRole("navigation", { name: "Settings" });
    await days.fill("21");
    await days.fill(original);
    await nav.getByRole("link", { name: "Bookings" }).click();
    await page.waitForURL("**/settings/bookings");
    expect(seen.confirms).toBe(4);

    await page.goto(`/staff/${tenant.slug}/settings/planning`);
    await page.getByLabel("Days before the event").fill("21");
    seen.accept = true;
    await nav.getByRole("link", { name: "Bookings" }).click();
    await page.waitForURL("**/settings/bookings");
    expect(seen.confirms).toBe(5);
    expect(seen.unloads).toBe(0);
    seen.accept = false;
    await page.goto(`/staff/${tenant.slug}/settings/planning`);
    await expect(page.getByLabel("Days before the event")).toHaveValue(original);
  });

  test("an anchor on the same page never asks", async () => {
    await page.goto(`/staff/${tenant.slug}/settings/profile`);
    const original = await page.getByLabel("Legal business name").inputValue();
    await page.getByLabel("Legal business name").fill(`Anchor ${run}`);
    const before = seen.confirms;
    await page.evaluate(() => { window.location.hash = "reply-to"; });
    await expect(page.getByLabel("Legal business name")).toHaveValue(`Anchor ${run}`);
    expect(seen.confirms).toBe(before);
    await page.getByLabel("Legal business name").fill(original);
  });

  test("reloading or closing the tab asks through the browser only while something is unsaved", async () => {
    // A real keystroke: browsers only ask once the page has had user input.
    await page.goto(`/staff/${tenant.slug}/settings/profile`);
    await page.getByLabel("Business address").click();
    await page.keyboard.type(" edited");
    await expect(unsaved(page.getByRole("region", { name: "Contract details" }))).toBeVisible();
    const before = seen.confirms;
    seen.accept = true;
    await page.reload();
    expect(seen.unloads).toBe(1);
    expect(seen.confirms).toBe(before);
    seen.accept = false;
    await page.reload();
    expect(seen.unloads).toBe(1);

    const temp = await page.context().newPage();
    const tempSeen = dialogs(temp);
    await temp.goto(`/staff/${tenant.slug}/settings/profile`);
    await temp.getByLabel("Business address").click();
    await temp.keyboard.type(" edited");
    await temp.close({ runBeforeUnload: true });
    await expect.poll(() => tempSeen.unloads).toBe(1);
    await expect(temp.getByLabel("Business address")).toHaveValue(/ edited$/); // stayed: the answer was no
    tempSeen.accept = true;
    await temp.close({ runBeforeUnload: true });
  });

  test("a stale success message goes when editing resumes, and a failed save stays unsaved", async () => {
    await page.goto(`/staff/${tenant.slug}/settings/taxes`);
    const deposit = page.getByRole("region", { name: "Deposit" });
    const field = page.getByLabel("Deposit due on signing (%)");
    await field.fill("45");
    await save(deposit).click();
    const saved = deposit.getByRole("status").filter({ hasText: "Deposit saved" });
    await expect(saved).toBeVisible();
    await expect(unsaved(deposit)).toHaveCount(0);
    await field.fill("46");
    await expect(saved).toHaveCount(0);
    await expect(unsaved(deposit)).toBeVisible();

    // The browser would stop an out-of-range number; a decimal gets past it to the server.
    await field.evaluate((el: HTMLInputElement) => el.setAttribute("step", "any"));
    await field.fill("46.5");
    await save(deposit).click();
    await expect(deposit.getByRole("alert").filter({ hasText: "whole percentage" })).toBeVisible();
    await expect(unsaved(deposit)).toBeVisible();
    expect((await legalRow(tenant)).deposit_percent).toBe(45);
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Bookings" }).click();
    await expect.poll(() => seen.confirms).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/settings\/taxes$/);
    await expect(field).toHaveValue("46.5");
    // Leaving the page for the next test.
    await field.fill("45");
    await expect(unsaved(deposit)).toHaveCount(0);
  });

  test("branding: choosing a file and removing a logo count as unsaved, and saving clears them", async () => {
    await page.goto(`/staff/${tenant.slug}/settings/branding`);
    const nav = page.getByRole("navigation", { name: "Settings" });
    const form = page.locator("form").filter({ has: page.getByLabel("Logo", { exact: true }) });
    const asks = async () => {
      const before = seen.confirms;
      await nav.getByRole("link", { name: "Bookings" }).click();
      await expect.poll(() => seen.confirms).toBe(before + 1);
      await expect(page).toHaveURL(/\/settings\/branding$/);
    };

    await page.getByLabel("Logo", { exact: true }).setInputFiles(logoFile);
    await expect(unsaved(form)).toBeVisible();
    await asks();
    await page.getByLabel("Logo", { exact: true }).setInputFiles([]);
    await expect(unsaved(form)).toHaveCount(0);

    const colour = page.getByLabel("Primary colour", { exact: true });
    const originalColour = await colour.inputValue();
    await colour.fill("#1e3a8a");
    await expect(unsaved(form)).toBeVisible();
    await colour.fill(originalColour);
    await expect(unsaved(form)).toHaveCount(0);

    await page.getByLabel("Logo", { exact: true }).setInputFiles(logoFile);
    await save(form).click();
    await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    await expect(unsaved(form)).toHaveCount(0);
    await expect(page.getByTestId("workspace-brand").getByRole("img")).toBeVisible();

    // After the save, the cleared file field isn't mistaken for an edit.
    const removeLogo = page.getByRole("checkbox", { name: /Remove the logo/ });
    await expect(removeLogo).toBeVisible();
    await removeLogo.check();
    await expect(unsaved(form)).toBeVisible();
    await asks();
    await removeLogo.uncheck();
    await expect(unsaved(form)).toHaveCount(0);

    await removeLogo.check();
    await save(form).click();
    await expect(page.getByTestId("workspace-brand").getByRole("img")).toHaveCount(0);
    await expect(unsaved(form)).toHaveCount(0);
    const before = seen.confirms;
    await nav.getByRole("link", { name: "Bookings" }).click();
    await page.waitForURL("**/settings/bookings");
    expect(seen.confirms).toBe(before);
    const { data } = await admin.from("tenants").select("logo_storage_path").eq("id", tenant.id).single();
    expect(data!.logo_storage_path).toBeNull();
  });

  test("the deposit and the legal details save separately, even from a stale tab", async () => {
    // A new business can set its deposit before it has legal details, without confirming them.
    const owner = await (await browser.newContext()).newPage();
    await signInStaff(owner, fresh.ownerEmail);
    const beforeFresh = await legalRow(fresh);
    await owner.goto(`/staff/${fresh.slug}/settings/taxes`);
    await owner.getByLabel("Deposit due on signing (%)").fill("25");
    await save(owner.getByRole("region", { name: "Deposit" })).click();
    await expect(owner.getByText(/Deposit saved/)).toBeVisible();
    expect(await legalRow(fresh)).toEqual({ ...beforeFresh, deposit_percent: 25 });
    await owner.goto(`/staff/${fresh.slug}/settings/profile`);
    await expect(owner.getByLabel("Legal business name")).toHaveValue("");
    await expect(owner.getByLabel("Deposit due on signing (%)")).toHaveCount(0);
    await owner.context().close();

    // A tab with the legal form open while the deposit changes elsewhere can't put the old percentage back.
    const staleTab = await page.context().newPage();
    await staleTab.goto(`/staff/${tenant.slug}/settings/profile`);
    await page.goto(`/staff/${tenant.slug}/settings/taxes`);
    await page.getByLabel("Deposit due on signing (%)").fill("77");
    await save(page.getByRole("region", { name: "Deposit" })).click();
    await expect(page.getByText(/Deposit saved/)).toBeVisible();

    await staleTab.getByLabel("Legal business name").fill(`Stale Tab ${run} Inc.`);
    await staleTab.getByLabel("Business address").fill("7 Stale St");
    await staleTab.getByLabel("Contact email").fill(`stale-${run}@example.test`);
    await save(staleTab.getByRole("region", { name: "Contract details" })).click();
    await expect(staleTab.getByText(/Settings saved/)).toBeVisible();
    expect(await legalRow(tenant)).toEqual({
      business_name: `Stale Tab ${run} Inc.`, business_address: "7 Stale St", contact_email: `stale-${run}@example.test`, deposit_percent: 77,
    });

    // And the reverse: a stale deposit form leaves the legal details alone.
    await staleTab.goto(`/staff/${tenant.slug}/settings/taxes`);
    await page.goto(`/staff/${tenant.slug}/settings/profile`);
    await page.getByLabel("Business address").fill("8 Newer Ave");
    await save(page.getByRole("region", { name: "Contract details" })).click();
    await expect(page.getByText(/Settings saved/)).toBeVisible();
    await staleTab.getByLabel("Deposit due on signing (%)").fill("20");
    await save(staleTab.getByRole("region", { name: "Deposit" })).click();
    await expect(staleTab.getByText(/Deposit saved/)).toBeVisible();
    expect(await legalRow(tenant)).toEqual({
      business_name: `Stale Tab ${run} Inc.`, business_address: "8 Newer Ave", contact_email: `stale-${run}@example.test`, deposit_percent: 20,
    });
    await staleTab.close();
  });

  test("staff see the deposit read-only with nothing to save, and it can't be reached from another business", async () => {
    const staff = await (await browser.newContext()).newPage();
    await signInStaff(staff, staffEmail);
    await staff.goto(`/staff/${tenant.slug}/settings/taxes`);
    const deposit = staff.getByRole("region", { name: "Deposit" });
    await expect(deposit).toContainText("20%");
    await expect(deposit).toContainText("Only the owner can change this.");
    await expect(deposit.locator("input")).toHaveCount(0);
    await staff.goto(`/staff/${tenant.slug}/settings/bookings`);
    await expect(staff.getByTestId("deposit-summary")).toContainText("20%");
    await expect(staff.getByTestId("deposit-summary").getByRole("link")).toHaveAttribute("href", `/staff/${tenant.slug}/settings/taxes#deposit`);
    await staff.goto(`/staff/${other.slug}/settings/taxes`);
    await expect(staff.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await staff.context().close();
  });

  test("on a phone: the back link and the menu drawer ask, and the saved form leaves the way clear", async () => {
    const phone = await (await browser.newContext(PHONE)).newPage();
    const phoneSeen = dialogs(phone);
    await signInStaff(phone, tenant.ownerEmail);
    await phone.goto(`/staff/${tenant.slug}/settings/planning`);
    const days = phone.getByLabel("Days before the event");
    await days.fill("30");

    await phone.getByTestId("settings-back").tap();
    await expect.poll(() => phoneSeen.confirms).toBe(1);
    await expect(phone).toHaveURL(/\/settings\/planning$/);
    await expect(days).toHaveValue("30");

    await phone.getByRole("button", { name: "Open menu" }).tap();
    await phone.getByTestId("nav-drawer").getByRole("link", { name: "Events" }).tap();
    await expect.poll(() => phoneSeen.confirms).toBe(2);
    await expect(phone).toHaveURL(/\/settings\/planning$/);
    await expect(days).toHaveValue("30");

    const deadline = phone.getByRole("region", { name: "Planning deadline" });
    await save(deadline).tap();
    await expect(deadline.getByRole("status").filter({ hasText: "Planning deadline saved." })).toBeVisible();
    await phone.getByTestId("settings-back").tap();
    await phone.waitForURL(`**/staff/${tenant.slug}/settings`);
    expect(phoneSeen.confirms).toBe(2);
    await phone.context().close();
  });
});
