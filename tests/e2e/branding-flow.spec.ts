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
import { brandTheme, suggestLooks } from "@/lib/branding/colors";
import { admin, pageScheme, signInStaff, waitForEmail } from "./support";
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
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const logoPathOf = (src: string | null) => /tenant-logos\/([^?]+)/.exec(src ?? "")?.[1];

test.describe.serial("business branding", () => {
  let browser: Browser;
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: Page;
  /** The client's page of the proposal sent with solid branding, kept open to see that it never changes. */
  let sentProposal: Page;
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
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    await expect(headerLogo(ownerA, a.displayName)).toHaveCount(0); // the name until a logo exists
    const preview = ownerA.getByTestId("branding-preview");
    await expect(preview).toContainText("What clients see. Nothing is saved or sent.");
    // Three parts, and none of the old header strips.
    for (const heading of ["Business logo", "Brand colours", "Preview"]) await expect(ownerA.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expect(ownerA.getByTestId("header-preview")).toHaveCount(0);
    await chooseLogo(ownerA, files["wide.png"]);
    const previewLogo = preview.getByRole("img", { name: a.displayName });
    await expect(previewLogo).toBeVisible();
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#ffff00");
    await expect(ownerA.getByTestId("contrast-note")).toContainText("Light colours are deepened");
    await expect(preview.getByText("Submit my selection")).toHaveCSS("color", "rgb(0, 0, 0)");
    // The preview is the client's page: on a gradient header a logo that isn't light gets the same white
    // backdrop the real proposal gives it, and on the solid header it has none.
    await expect(previewLogo.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await ownerA.getByTestId(`look-${suggestLooks("#ffff00")[0].key}`).click();
    await expect(previewLogo.locator("xpath=..")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(ownerA.getByTestId("preview-hero")).toHaveCSS("color", "rgb(255, 255, 255)");
    await ownerA.getByTestId("look-solid").click();
    await expect(previewLogo.locator("xpath=..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);

    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    const logo = headerLogo(ownerA, a.displayName);
    await expect(logo).toBeVisible();
    const box = (await logo.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(32.5);
    // 1600 x 400 with the shape inside 10-90% of the width and 20-80% of the height: the upload trims
    // the empty transparent edges, so the shape's own 1280 x 240 is shown, not stretched or cut.
    expect(box.width / box.height).toBeCloseTo((1600 * 0.8) / (400 * 0.6), 0);
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);
    const { data } = await admin.from("tenants").select("brand_colors, logo_storage_path, branding_version").eq("id", a.id).single();
    expect(data).toMatchObject({ branding_version: 1, brand_colors: { primary: "#ffff00" } });
    expect(data!.logo_storage_path).toMatch(new RegExp(`^${a.id}/logos/`));
  });

  test("a client's proposal shows the logo it was sent with, even after the owner replaces it", async () => {
    const sentAt = Date.now();
    await sendProposalFromEventPage(ownerA, a, eventId);
    const email = await waitForEmail(clientEmail, { after: sentAt, subject: /sent you a proposal/ });
    const client = (sentProposal = await (await browser.newContext({ viewport: PHONE })).newPage());
    await client.goto(/(http:\/\/\S+\/p#\S+)/.exec(email.text)![1]);
    await client.waitForURL("**/proposals/**");
    const sentLogo = client.getByRole("img", { name: a.displayName }).first();
    await expect(sentLogo).toBeVisible();
    const sentPath = logoPathOf(await sentLogo.getAttribute("src"));
    await expect(client.locator("header").first()).toHaveCSS("color", "rgb(0, 0, 0)"); // readable on yellow

    // The owner replaces the logo with light artwork and a dark colour.
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    await chooseLogo(ownerA, files["light.png"]);
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#1e3a8a");
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    // Light artwork sits on a dark backdrop in the light header, and as it is in the dark one.
    if ((await pageScheme(ownerA)) === "dark") await expect(headerLogo(ownerA, a.displayName).locator("xpath=..")).not.toHaveClass(/bg-neutral-900|bg-white/);
    else await expect(headerLogo(ownerA, a.displayName).locator("xpath=..")).toHaveClass(/bg-neutral-900/);
    expect(logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"))).not.toBe(sentPath);

    await client.reload();
    expect(logoPathOf(await client.getByRole("img", { name: a.displayName }).first().getAttribute("src"))).toBe(sentPath);
  });

  test("disguised and oversized files are refused and the current logo stays", async () => {
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    const before = logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"));
    await chooseLogo(ownerA, files["huge.png"]);
    await expect(ownerA.getByRole("alert").filter({ hasText: "The logo must be 4 MB or smaller." })).toBeVisible();
    await chooseLogo(ownerA, files["disguised.png"]);
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("alert").filter({ hasText: "isn't a PNG, JPEG or WebP image" })).toContainText("Your current logo is unchanged.");
    await ownerA.reload();
    expect(logoPathOf(await headerLogo(ownerA, a.displayName).getAttribute("src"))).toBe(before);
  });

  test("a stale tab can't overwrite newer branding, and keeps what was typed", async () => {
    const stale = await ownerA.context().newPage();
    await stale.goto(`/staff/${a.slug}/settings/branding`);
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#0f766e");
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();

    await stale.getByLabel("Primary colour", { exact: true }).fill("#7c3aed");
    await stale.getByRole("button", { name: "Save changes" }).click();
    await expect(stale.getByRole("alert").filter({ hasText: "Someone else saved changes first" })).toBeVisible();
    await expect(stale.getByLabel("Primary colour", { exact: true })).toHaveValue("#7c3aed");
    const { data } = await admin.from("tenants").select("brand_colors").eq("id", a.id).single();
    expect(data!.brand_colors).toMatchObject({ primary: "#0f766e" });
    await stale.close();
  });

  test("the owner chooses a suggested look, makes an accent their own, and can return to solid", async () => {
    const colors = async () => (await admin.from("tenants").select("brand_colors").eq("id", a.id).single()).data!.brand_colors;
    const gradientOf = (primary: string, accent: string) => brandTheme({ primary, accent, gradient: "on" });
    const css = (g: { from: string; to: string }) => `linear-gradient(135deg, ${rgb(g.from)}, ${rgb(g.to)})`;
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    const preview = ownerA.getByTestId("branding-preview");
    const hero = ownerA.getByTestId("preview-hero");
    const radio = (name: string) => ownerA.getByRole("radio", { name, exact: true });
    const accent = ownerA.getByLabel("Accent colour", { exact: true });
    const savedAccent = ownerA.locator('input[name="accent_color"]');

    // Solid until the owner chooses otherwise, although this business already holds an accent from before
    // gradients: that accent is offered as the Custom look, not chosen.
    expect(await colors()).toEqual({ primary: "#0f766e", accent: "#E11D48" });
    const teal = suggestLooks("#0f766e");
    await expect(radio("Solid")).toBeChecked();
    await expect(preview).toHaveAttribute("data-style", "solid");
    await expect(hero).toHaveCSS("background-image", "none");
    await expect(ownerA.getByTestId("brand-looks").getByRole("radio")).toHaveCount(teal.length + 2);
    for (const look of teal) await expect(radio(look.label)).not.toBeChecked();
    await expect(radio("Custom")).not.toBeChecked();
    await expect(savedAccent).toHaveCount(0);
    // Each swatch is the real, contrast-safe gradient it would save.
    await expect(ownerA.getByTestId(`look-${teal[1].key}`).locator("span").first()).toHaveCSS("background-image", css(gradientOf("#0f766e", teal[1].accent).gradient!));

    // One tap chooses a look; the preview follows.
    await ownerA.getByTestId(`look-${teal[0].key}`).click();
    await expect(radio(teal[0].label)).toBeChecked();
    await expect(preview).toHaveAttribute("data-style", "gradient");
    await expect(savedAccent).toHaveValue(teal[0].accent);
    await expect(hero).toHaveCSS("background-image", css(gradientOf("#0f766e", teal[0].accent).gradient!));

    // The looks are made for the primary colour: a new one brings new looks, and the chosen kind stays chosen.
    await ownerA.getByLabel("Primary colour", { exact: true }).fill("#cbc7ff");
    const pale = suggestLooks("#cbc7ff");
    const followed = pale.find((l) => l.key === teal[0].key)!;
    const theme = gradientOf("#cbc7ff", followed.accent);
    await expect(radio(followed.label)).toBeChecked();
    await expect(savedAccent).toHaveValue(followed.accent);
    await expect(ownerA.getByTestId("contrast-note")).toContainText("Light colours are deepened");
    await expect(hero).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(hero).toHaveCSS("background-image", css(theme.gradient!));
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);

    // The other preview: the client's event page, with the wash and the gradient progress.
    await ownerA.getByRole("tab", { name: "Event page" }).click();
    await expect(hero).toHaveCount(0);
    // The preview shows the Wash for the page's theme, like the client's page in the same theme.
    await expect(ownerA.getByTestId("preview-wash")).toHaveCSS("background-image", css(brandTheme({ primary: "#cbc7ff", accent: followed.accent, gradient: "on" }, await pageScheme(ownerA)).wash!));
    await expect(ownerA.getByTestId("preview-progress")).toHaveCSS("background-image", css(theme.gradient!));
    await expect(ownerA.getByTestId("preview-wash").getByText("Open planning")).toHaveCSS("background-color", rgb(theme.fill));
    expect(await noSideScroll(ownerA)).toBeLessThanOrEqual(0);
    await ownerA.getByRole("tab", { name: "Proposal" }).click();

    // Advanced: an accent of the owner's own. One that isn't a colour is refused before anything is saved.
    await expect(accent).toBeHidden();
    await ownerA.getByTestId("custom-accent").locator("summary").click();
    await expect(accent).toHaveValue("#e11d48"); // the accent it already had
    await accent.fill("#12");
    await expect(radio("Custom")).toBeChecked();
    await expect(ownerA.getByRole("alert").filter({ hasText: "Enter the accent colour as a hex value" })).toBeVisible();
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("alert").filter({ hasText: "Enter the accent colour as a hex value" }).first()).toBeVisible();
    expect(await colors()).toEqual({ primary: "#0f766e", accent: "#E11D48" });

    await accent.fill("#FACC15");
    await expect(hero).toHaveCSS("background-image", css(gradientOf("#cbc7ff", "#facc15").gradient!));
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    expect(await colors()).toEqual({ primary: "#cbc7ff", accent: "#facc15", gradient: "on" });
    // A saved custom accent comes back as the Custom look, its field open.
    await ownerA.reload();
    await expect(radio("Custom")).toBeChecked();
    await expect(accent).toHaveValue("#facc15");
    for (const look of pale) await expect(radio(look.label)).not.toBeChecked();

    // The proposal sent earlier keeps the solid branding it was sent with.
    const { data: sent } = await admin.from("proposals").select("offer_snapshot").eq("event_id", eventId).eq("status", "sent").single();
    expect((sent!.offer_snapshot as { branding: { brand_colors: Record<string, string> } }).branding.brand_colors).not.toHaveProperty("gradient");

    // In the browser too: its header is still the solid yellow it was sent with, dark text on it.
    await sentProposal.reload();
    await expect(sentProposal.getByTestId("proposal-hero")).toHaveCSS("background-image", "none");
    await expect(sentProposal.getByTestId("proposal-hero")).toHaveCSS("background-color", "rgb(255, 255, 0)");
    await expect(sentProposal.getByTestId("proposal-hero")).toHaveCSS("color", "rgb(0, 0, 0)");
    await sentProposal.context().close();

    // A proposal sent now carries the gradient: white text on the deepened colours, none of it softened.
    const laterEmail = `e2e-brand-later-${run}@example.test`;
    const [laterEvent, laterClient] = [randomUUID(), randomUUID()];
    await admin.from("clients").insert({ id: laterClient, tenant_id: a.id, name: "Kim & Ari", email: laterEmail });
    await admin.from("events").insert({ id: laterEvent, tenant_id: a.id, title: `E2E Gradient Wedding ${run}`, event_type: "wedding", event_date: "2027-09-04" });
    await admin.from("event_clients").insert({ tenant_id: a.id, event_id: laterEvent, client_id: laterClient, is_primary: true, can_sign: true });
    const sentAt = Date.now();
    await sendProposalFromEventPage(ownerA, a, laterEvent);
    const email = await waitForEmail(laterEmail, { after: sentAt, subject: /sent you a proposal/ });
    const later = await (await browser.newContext({ viewport: PHONE })).newPage();
    await later.goto(/(http:\/\/\S+\/p#\S+)/.exec(email.text)![1]);
    await later.waitForURL("**/proposals/**");
    const sentTheme = brandTheme({ primary: "#cbc7ff", accent: "#facc15", gradient: "on" });
    const laterHero = later.getByTestId("proposal-hero");
    await expect(laterHero).toHaveCSS("background-image", `linear-gradient(135deg, ${rgb(sentTheme.gradient!.from)}, ${rgb(sentTheme.gradient!.to)})`);
    await expect(laterHero).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(laterHero.getByRole("list", { name: "How this works" })).toHaveCSS("opacity", "1");
    expect(await noSideScroll(later)).toBeLessThanOrEqual(0);

    // Back to solid: the pages are as before, and the accent is kept for next time.
    await ownerA.goto(`/staff/${a.slug}/settings/branding`);
    await ownerA.getByTestId("look-solid").click();
    await expect(hero).toHaveCSS("background-image", "none");
    await ownerA.getByRole("button", { name: "Save changes" }).click();
    await expect(ownerA.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
    expect(await colors()).toEqual({ primary: "#cbc7ff", accent: "#facc15" });
    // The proposal sent with the gradient keeps it.
    await later.reload();
    await expect(laterHero).toHaveCSS("background-image", `linear-gradient(135deg, ${rgb(sentTheme.gradient!.from)}, ${rgb(sentTheme.gradient!.to)})`);
    await later.context().close();
  });

  test("another business shows its own logo; staff can only view branding", async () => {
    const ownerB = await (await browser.newContext({ viewport: PHONE })).newPage();
    await signInStaff(ownerB, b.ownerEmail);
    await ownerB.goto(`/staff/${b.slug}/settings/branding`);
    await chooseLogo(ownerB, files["tall.jpg"]);
    await ownerB.getByRole("button", { name: "Save changes" }).click();
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
    await staff.goto(`/staff/${a.slug}/settings/branding`);
    await expect(staff.getByText("Only the owner can change branding.")).toBeVisible();
    await expect(staff.getByLabel("Logo", { exact: true })).toHaveCount(0);
    await expect(headerLogo(staff, a.displayName)).toBeVisible();
    await staff.context().close();
  });
});
