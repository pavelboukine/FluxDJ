/**
 * End-to-end staff flow in a real browser against local Supabase:
 * magic-link login (via Mailpit), gear with real and disguised uploads,
 * packages, templates, client/event creation, proposal draft editing with
 * optimistic versions, live preview pricing, mobile layout and isolation.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(
  execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
) as { API_URL: string; SERVICE_ROLE_KEY: string };
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL)) throw new Error("E2E tests run against local Supabase only");
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MAILPIT = "http://127.0.0.1:54324";
const OWNER = "owner@bouprod.example";
const run = randomUUID().slice(0, 6);

// A valid 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function latestMagicLink(email: string, after: number): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = (await res.json()) as { messages: { ID: string; Created: string }[] };
    const fresh = messages.find((m) => Date.parse(m.Created) >= after - 1000);
    if (fresh) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)).json()) as { HTML: string };
      const href = /href="([^"]+\/auth\/confirm[^"]+)"/.exec(message.HTML)?.[1];
      if (href) return href.replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic link email for ${email}`);
}

async function signIn(page: Page, email: string) {
  const started = Date.now();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("If that email belongs to a staff account");
  await page.goto(await latestMagicLink(email, started));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/staff/bouprod");
}

test.describe.serial("staff interface", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let eventUrl = "";
  let proposalUrl = "";
  let gearName = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    context = await browser.newContext();
    page = await context.newPage();
  });

  test("signed-out visitors are sent to login; unknown emails get no link", async () => {
    const anonymousContext = await browser.newContext();
    const anonymous = await anonymousContext.newPage();
    await anonymous.goto("/staff/bouprod/gear");
    await expect(anonymous).toHaveURL(/\/login$/);
    const stranger = `nobody-${run}@example.test`;
    await anonymous.getByLabel("Email").fill(stranger);
    await anonymous.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(anonymous.getByRole("status")).toContainText("If that email belongs to a staff account");
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${stranger}"`)}`);
    expect(((await res.json()) as { messages: unknown[] }).messages).toHaveLength(0);
    const { data } = await admin.auth.admin.listUsers();
    expect(data.users.some((u) => u.email === stranger)).toBe(false);
    await anonymousContext.close();
  });

  test("staff sign in with a magic link", async () => {
    await signIn(page, OWNER);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("another DJ's workspace is not reachable", async () => {
    const res = await page.goto("/staff/other-dj");
    expect(res?.status()).toBe(404);
  });

  test("gear: create, edit price, upload a real photo, reject a disguised file", async () => {
    gearName = `E2E Fog machine ${run}`;
    await page.goto("/staff/bouprod/gear/new");
    await page.getByLabel("Name").fill(gearName);
    await page.getByLabel("Price (CAD)").fill("90");
    await page.getByLabel("Description").fill("Low-lying fog for the first dance.");
    await page.getByRole("button", { name: "Create gear item" }).click();
    await expect(page.getByRole("heading", { name: gearName })).toBeVisible();

    await page.getByLabel("Price (CAD)").fill("95.50");
    await page.getByRole("button", { name: "Save gear item" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    const { data: saved } = await admin.from("gear_items").select("id, default_price_cents").eq("name", gearName).single();
    expect(saved!.default_price_cents).toBe(9550);

    await page.getByLabel("Photo or video").setInputFiles({ name: "fog.png", mimeType: "image/png", buffer: PNG });
    await page.getByLabel("Description (alt text)").fill("Fog machine on stage");
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Uploaded." })).toBeVisible();
    await expect(page.getByRole("img", { name: "Fog machine on stage" })).toBeVisible();

    // HTML renamed to .png with an image/png type: rejected by content and deleted.
    await page.getByLabel("Photo or video").setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<html><script>alert(1)</script></html>") });
    await page.getByLabel("Description (alt text)").fill("Not really an image");
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not a supported image or video" })).toBeVisible();

    const { data: media } = await admin.from("gear_media").select("id").eq("gear_item_id", saved!.id);
    expect(media).toHaveLength(1);
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "bouprod").single();
    const { data: objects } = await admin.storage.from("gear-media").list(`${tenant!.id}/gear-items/${saved!.id}`);
    expect(objects).toHaveLength(1);
  });

  test("packages: create a package and include gear", async () => {
    await page.goto("/staff/bouprod/packages/new");
    await page.getByLabel("Name").fill(`E2E Package ${run}`);
    await page.getByLabel("Base price (CAD)").fill("1000");
    await page.getByRole("button", { name: "Create package" }).click();
    await expect(page.getByRole("heading", { name: `E2E Package ${run}` })).toBeVisible();
    await page.getByLabel(new RegExp(gearName)).fill("1");
    await page.getByRole("button", { name: "Save included gear" }).click();
    await expect(page.getByText("Included gear saved.")).toBeVisible();
  });

  test("templates: compose three packages, a recommended one, addons and questions", async () => {
    await page.goto("/staff/bouprod/templates");
    await page.getByLabel("Name").fill(`E2E Wedding ${run}`);
    await page.getByRole("button", { name: "Create template" }).click();
    await expect(page.getByRole("heading", { name: `E2E Wedding ${run}` })).toBeVisible();
    await page.getByLabel("Package 1").selectOption({ label: "Essential ($1,500.00)" });
    await page.getByLabel("Package 2").selectOption({ label: "Signature ($2,200.00)" });
    await page.getByLabel("Package 3").selectOption({ label: "Premium ($3,000.00)" });
    await page.getByLabel("Recommended (most popular) package").selectOption({ label: "Signature ($2,200.00)" });
    await page.getByRole("checkbox", { name: new RegExp(gearName) }).check();
    await page.getByRole("checkbox", { name: "DEMO: Where will the ceremony take place?" }).check();
    await page.getByRole("checkbox", { name: "DEMO: Where will cocktail hour take place?" }).check();
    await page.getByRole("button", { name: "Save template contents" }).click();
    await expect(page.getByText("Template saved.")).toBeVisible();
  });

  test("questions: create a question and a rule that requires gear", async () => {
    await page.goto("/staff/bouprod/questions");
    await page.getByLabel("Question", { exact: true }).fill(`E2E Will there be fog effects? ${run}`);
    await page.getByLabel("Answer type").selectOption("boolean");
    await page.getByRole("button", { name: "Create question" }).click();
    await expect(page.getByRole("heading", { name: `E2E Will there be fog effects? ${run}` })).toBeVisible();
    await page.getByLabel("When the answer is").selectOption("true");
    await page.getByLabel("Require gear").selectOption({ label: gearName });
    await page.getByLabel("Reason shown to the client").fill("Fog effects need a fog machine.");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText(`If answer is yes → require 1 × ${gearName}`)).toBeVisible();
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  });

  test("every staff page renders", async () => {
    for (const path of ["", "/events", "/clients", "/gear", "/gear?show=archived", "/packages", "/questions", "/templates"]) {
      const res = await page.goto(`/staff/bouprod${path}`);
      expect(res?.status(), path).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("events: create an event with a new client", async () => {
    await page.goto("/staff/bouprod/events/new");
    await page.getByLabel("Title").fill(`E2E Wedding of Jo & Lee ${run}`);
    await page.getByLabel("Date").fill("2027-09-18");
    await page.getByLabel("Venue name").fill("Le Grand Salon");
    await page.getByLabel("Name", { exact: true }).fill("Jo & Lee");
    await page.getByLabel("Email").fill(`jo-${run}@example.test`);
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page.getByRole("heading", { name: `E2E Wedding of Jo & Lee ${run}` })).toBeVisible();
    await expect(page.getByText(`jo-${run}@example.test`)).toBeVisible();
    eventUrl = page.url();
  });

  test("proposal: open a draft from the template and see live pricing", async () => {
    await page.getByLabel("Start from template").selectOption({ label: `E2E Wedding ${run}` });
    await page.getByRole("button", { name: "Start proposal draft" }).click();
    await page.waitForURL("**/proposals/**");
    proposalUrl = page.url();

    const preview = page.locator("section", { has: page.getByRole("heading", { name: "Your total" }) });
    // The most popular package is badged and preselected.
    await expect(page.getByRole("button", { name: /^Signature Most popular/ })).toHaveAttribute("aria-pressed", "true");
    await expect(preview).toContainText("Provisional");

    await page.getByRole("group", { name: /ceremony/i }).getByLabel("A separate space").check();
    await page.getByRole("group", { name: /cocktail/i }).getByLabel("A separate space").check();
    // Spec example: two separate spaces need two speakers; Signature includes one, so one is charged.
    await expect(page.getByRole("heading", { name: "Required for your event" })).toBeVisible();
    await expect(preview).toContainText("1 × Additional-location speaker");
    await expect(preview).toContainText("$2,701.91");
    await expect(preview).not.toContainText("Provisional");

    await page.getByRole("button", { name: /^Essential/ }).click();
    await expect(preview).toContainText("2 × Additional-location speaker");
  });

  test("proposal: saving edits the single draft in place and never freezes it", async () => {
    const eventId = eventUrl.split("/").pop()!;
    const draftState = async () => {
      const { data } = await admin.from("proposals").select("draft_version, offer_snapshot, draft_offer").eq("event_id", eventId);
      return data!.map((p) => ({
        version: p.draft_version,
        frozen: p.offer_snapshot !== null,
        expiry: (p.draft_offer as { expiry_days?: number }).expiry_days,
      }));
    };

    await page.getByLabel("Offer valid for (days after sending)").fill("21");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(draftState).toEqual([{ version: 1, frozen: false, expiry: 21 }]);
    // Wait for the save to finish (message shown, button idle) before editing again.
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();

    // A second save without reloading uses the refreshed version.
    await expect(page.getByLabel("Offer valid for (days after sending)")).toHaveValue("21");
    await page.getByLabel("Offer valid for (days after sending)").fill("22");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(draftState).toEqual([{ version: 2, frozen: false, expiry: 22 }]);
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
  });

  test("proposal: a stale tab cannot overwrite newer edits", async () => {
    const stale = await context.newPage();
    await stale.goto(proposalUrl);
    await page.reload();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    await stale.getByRole("button", { name: "Save draft" }).click();
    await expect(stale.getByRole("alert").filter({ hasText: "Someone else saved changes first" })).toBeVisible();
    await stale.close();
  });

  test("proposal: edits typed while a save is pending survive it and save next", async () => {
    const eventId = eventUrl.split("/").pop()!;
    const draftRow = async () => {
      const { data } = await admin.from("proposals").select("draft_version, draft_offer").eq("event_id", eventId).single();
      const offer = data!.draft_offer as { expiry_days?: number; intro?: string | null };
      return { version: data!.draft_version, expiry: offer.expiry_days, intro: offer.intro ?? null };
    };
    await page.goto(proposalUrl);
    const before = await draftRow();
    const expiry = page.getByLabel("Offer valid for (days after sending)");
    const intro = page.getByLabel("Intro shown to the client");
    const saveButton = page.getByRole("button", { name: "Save draft" });

    // Let save requests reach the server, but hold their responses until released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(proposalUrl, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });

    await expiry.fill("30");
    await saveButton.click();
    await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
    // The server has committed the save; only the response is delayed.
    await expect.poll(draftRow).toEqual({ version: before.version + 1, expiry: 30, intro: before.intro });

    // Edit another field while the save is still pending.
    await intro.fill("Typed while the save was pending");
    release();
    await expect(saveButton).toBeEnabled();
    await expect(page.getByText("Draft saved. Nothing has been sent.")).toBeVisible();
    await page.unroute(proposalUrl);

    // The completed save did not replace the newer input, and it is flagged as unsaved.
    await expect(intro).toHaveValue("Typed while the save was pending");
    await expect(expiry).toHaveValue("30");
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    expect(await draftRow()).toEqual({ version: before.version + 1, expiry: 30, intro: before.intro });

    // Saving again stores it, using the refreshed version (no false conflict).
    await saveButton.click();
    await expect.poll(draftRow).toEqual({ version: before.version + 2, expiry: 30, intro: "Typed while the save was pending" });
    await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "Someone else saved" })).toHaveCount(0);

    // Applying a template intentionally replaces the editor's contents, including unsaved choices.
    await page.getByLabel("Package 1").selectOption({ label: "Premium ($3,000.00)" });
    await page.getByLabel("Template").selectOption({ label: `E2E Wedding ${run}` });
    await page.getByRole("button", { name: "Apply template" }).click();
    await expect(page).toHaveURL(new RegExp(`\\?applied=${before.version + 3}$`));
    await expect(page.getByLabel("Package 1").locator("option:checked")).toHaveText("Essential ($1,500.00)");
    await expect(expiry).toHaveValue("14");
    await expect.poll(draftRow).toEqual({ version: before.version + 3, expiry: 14, intro: null });

    // ...and saving still works afterwards.
    await saveButton.click();
    await expect.poll(async () => (await draftRow()).version).toBe(before.version + 4);
  });

  test("proposal preview is readable at phone width without sideways scrolling", async () => {
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${proposalUrl}/preview`);
    await expect(phone.getByRole("heading", { name: "Your total" })).toBeVisible();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("signed-out visitors cannot open the proposal or its preview", async () => {
    const anonymous = await browser.newContext();
    const p = await anonymous.newPage();
    await p.goto(`${proposalUrl}/preview`);
    await expect(p).toHaveURL(/\/login$/);
    await anonymous.close();
  });
});
