/**
 * The client proposal experience in real browsers: package comparison, gear
 * photos (resized delivery, gallery, video, failures, access), questions and
 * rules, extras and exact pricing, saving, review and submission, frozen
 * content, phone layouts and unavailable states.
 *
 * Fixtures go through the same database functions the app calls (the staff
 * send screens are covered by proposal-flow.spec.ts), and the client's
 * proposal session is created exactly as the link exchange creates it, so no
 * sign-in form or per-IP link limit is used. Dedicated e2e tenants only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import sharp from "sharp";
import { formatCents } from "../../src/lib/money";
import { parseOfferSnapshot, priceSelection, type OfferSnapshot } from "../../src/lib/pricing";
import { must, sessionFor } from "./booking";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const REVIEW_DIR = "review-samples/proposal-experience";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const run = randomUUID().slice(0, 6);

let tenant: TestTenant;
let other: TestTenant;

/** A large labelled "equipment" photo: a multi-megabyte JPEG, like a phone camera original. */
async function equipmentPhoto(label: string, width: number, height: number, hue: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,22%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,48%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="${width * 0.3}" y="${height * 0.25}" width="${width * 0.4}" height="${height * 0.45}" rx="${width * 0.04}" fill="#111" stroke="#ddd" stroke-width="${width * 0.006}"/>
    <circle cx="${width / 2}" cy="${height * 0.47}" r="${Math.min(width, height) * 0.13}" fill="hsl(${hue},90%,70%)"/>
    <text x="50%" y="${height * 0.86}" font-family="Helvetica, Arial" font-size="${Math.round(width / 14)}" fill="#fff" text-anchor="middle">${label}</text>
  </svg>`;
  // Per-pixel sensor-like grain, so the JPEG is as heavy as a real camera original.
  const pixels = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
  const noise = randomBytes(pixels.length);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(0, Math.min(255, pixels[i] + (noise[i] % 49) - 24));
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/** A one-second WebM recorded by the browser itself (no video tools needed). */
async function recordedVideo(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage();
  const base64 = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
    const ctx = canvas.getContext("2d")!;
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start();
    for (let f = 0; f < 15; f++) {
      ctx.fillStyle = `hsl(${f * 24}, 70%, 50%)`;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#fff";
      ctx.font = "28px sans-serif";
      ctx.fillText("Uplights demo", 70, 130);
      await new Promise((r) => setTimeout(r, 66));
    }
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  });
  await page.close();
  return Buffer.from(base64, "base64");
}

async function addMedia(tenantId: string, gearKey: string, items: { file?: Buffer; ext: "jpg" | "webm"; alt: string }[]) {
  const { data: gear } = await must(admin.from("gear_items").select("id").eq("tenant_id", tenantId).eq("key", gearKey).single());
  for (const [i, item] of items.entries()) {
    const path = `${tenantId}/gear-items/${gear!.id}/${randomUUID()}.${item.ext}`;
    const contentType = item.ext === "jpg" ? "image/jpeg" : "video/webm";
    // No file: a media record whose object is missing (the page must show an honest placeholder).
    if (item.file) await must(admin.storage.from("gear-media").upload(path, item.file, { contentType }));
    await must(admin.from("gear_media").insert({ tenant_id: tenantId, gear_item_id: gear!.id, storage_path: path, kind: item.ext === "jpg" ? "image" : "video", content_type: contentType, alt_text: item.alt, sort_order: i }));
  }
}

/** Sends the "Wedding (DEMO)" offer for a new event. Returns the proposal id and its link token hash. */
async function sendProposal(t: TestTenant, title: string): Promise<{ proposalId: string; tokenHash: string; eventId: string }> {
  const eventId = randomUUID();
  const clientId = randomUUID();
  await must(admin.from("clients").insert({ id: clientId, tenant_id: t.id, name: "Robin & Kai", email: `client-${run}-${randomUUID().slice(0, 4)}@example.test` }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: t.id, title, event_type: "wedding", event_date: "2027-10-09", venue_name: "E2E Hall", internal_notes: `Staff-only note ${run}` }));
  await must(admin.from("event_clients").insert({ tenant_id: t.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  const staffDb = await sessionFor(t.ownerEmail);
  const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", t.id).eq("name", "Wedding (DEMO)").single());
  const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
  const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input }));
  const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
  const tokenHash = sha256(randomBytes(32).toString("base64url"));
  await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: tokenHash }));
  return { proposalId: proposalId as string, tokenHash, eventId };
}

/** A proposal session exactly as /p/exchange creates one, set as the browser's cookie. Returns the cookie value. */
async function openSession(context: BrowserContext, t: TestTenant, proposalId: string, tokenHash: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const { data } = await must(admin.rpc("exchange_proposal_link", { p_token_hash: tokenHash, p_session_hash: sha256(token), p_tenant_slug: t.slug, p_session_seconds: 3600 }));
  expect((data as { status: string }).status).toBe("ok");
  await context.addCookies([{ name: "flux_proposal", value: token, domain: "127.0.0.1", path: `/${t.slug}/proposals/${proposalId}`, httpOnly: true, sameSite: "Lax" }]);
  return token;
}

/** An optional extra's card (the outer list item, not its list of reasons). */
const extraCard = (page: Page, name: string) =>
  page.locator("section", { has: page.getByRole("heading", { name: "Optional extras" }) }).locator(":scope > ul > li").filter({ hasText: name });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${REVIEW_DIR}/${name}.png`, fullPage });

type MediaHit = { url: string; method: string; status: number; type: string; bytes: number };

test.describe.serial("client proposal experience", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let proposalId = "";
  let tokenHash = "";
  let url = "";
  let offer: OfferSnapshot;
  const media: MediaHit[] = [];
  const storageRequests: string[] = [];

  test.beforeAll(async ({ browser: b }) => {
    test.setTimeout(120_000);
    browser = b;
    mkdirSync(REVIEW_DIR, { recursive: true });
    [tenant, other] = await Promise.all([createTestTenant("pexp", { catalog: true }), createTestTenant("pexp-other", { catalog: true })]);
    await must(admin.from("tenants").update({ brand_colors: { primary: "#4c1d95" } }).eq("id", tenant.id));

    const [main, speaker, uplightsA, uplightsB, portrait] = await Promise.all([
      equipmentPhoto("Main sound system", 4000, 3000, 210),
      equipmentPhoto("Speaker on stand", 4000, 3000, 160),
      equipmentPhoto("Uplight (front)", 4000, 3000, 280),
      equipmentPhoto("Uplights in a room", 4000, 3000, 300),
      equipmentPhoto("Uplight (tall)", 3000, 4000, 320),
    ]);
    const video = await recordedVideo(browser);
    await addMedia(tenant.id, "main_sound_system", [{ file: main, ext: "jpg", alt: "Two black speakers and a subwoofer" }]);
    await addMedia(tenant.id, "additional_location_speaker", [{ file: speaker, ext: "jpg", alt: "Powered speaker on a tripod stand" }]);
    await addMedia(tenant.id, "uplights_4", [
      { file: uplightsA, ext: "jpg", alt: "A small uplight seen from the front" },
      { file: uplightsB, ext: "jpg", alt: "Four uplights washing a wall in purple" },
      { file: portrait, ext: "jpg", alt: "A tall uplight, portrait photo" },
      { file: video, ext: "webm", alt: "Short video of the uplights changing colour" },
    ]);
    await addMedia(tenant.id, "wireless_mic", [{ ext: "jpg", alt: "Handheld wireless microphone" }]); // object missing on purpose

    ({ proposalId, tokenHash } = await sendProposal(tenant, `E2E Experience Wedding ${run}`));
    url = `/${tenant.slug}/proposals/${proposalId}`;
    offer = parseOfferSnapshot((await must(admin.from("proposals").select("offer_snapshot").eq("id", proposalId).single())).data!.offer_snapshot);

    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await openSession(context, tenant, proposalId, tokenHash);
    page = await context.newPage();
    page.on("response", async (r: Response) => {
      const u = new URL(r.url());
      if (u.pathname.includes("/proposals/") && u.pathname.includes("/media/")) {
        const body = r.status() === 200 && r.request().method() === "GET" && !r.headers()["content-type"]?.startsWith("video") ? await r.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
        media.push({ url: u.pathname + u.search, method: r.request().method(), status: r.status(), type: r.headers()["content-type"] ?? "", bytes: body.length });
      }
    });
    page.on("request", (r) => {
      if (r.url().includes("/storage/v1/object/")) storageRequests.push(r.url());
    });
  });

  test.afterAll(async () => {
    await context?.close();
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("desktop: three packages in order, one recommended badge, large resized photos, no originals", async () => {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1, name: `E2E Experience Wedding ${run}` })).toBeVisible();
    const cards = page.getByTestId("package-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.getByRole("heading", { level: 3 })).toHaveText(["Essential", "Signature", "Premium"]);
    await expect(page.getByText("Recommended", { exact: true })).toHaveCount(1);
    await expect(cards.nth(1).getByText("Recommended", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Signature/ })).toBeChecked();
    await expect(page.locator("body")).not.toContainText(`Staff-only note ${run}`);

    // Package photos: the lead photo of the first included item with a photo (main sound system), large and uncropped.
    const lead = cards.nth(0).locator("img").first();
    await expect(lead).toHaveJSProperty("complete", true);
    const box = (await lead.boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    expect(await lead.evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("contain");
    await page.waitForLoadState("networkidle");
    await shot(page, "01-desktop-package-comparison");

    // Only resized WebP images were downloaded: no originals, no videos.
    // GET downloads only (a HEAD is the access probe after a failed photo, with no body).
    const images = media.filter((m) => m.status === 200 && m.method === "GET");
    expect(images.length).toBeGreaterThan(0);
    for (const m of images) {
      expect(m.type, JSON.stringify(m)).toBe("image/webp");
      expect(Number(new URL(m.url, "http://x").searchParams.get("w"))).toBeLessThanOrEqual(800);
    }
    expect(storageRequests).toEqual([]);
    expect(media.some((m) => m.url.includes("/uplights_4/3"))).toBe(false);
    const original = (await admin.storage.from("gear-media").download(offer.gear.main_sound_system.media[0].storage_path)).data!.size;
    const card = media.find((m) => m.url.includes("/main_sound_system/0") && m.status === 200)!;
    console.log(`[media] original main_sound_system ${original} bytes; card image ${card.url} ${card.bytes} bytes; ${images.length} image responses on load: ${images.map((m) => `${m.url.split("/media/")[1]}=${m.bytes}`).join(", ")}`);
    expect(original).toBeGreaterThan(5_000_000);
    expect(card.bytes).toBeLessThan(original / 20);
  });

  test("choosing a package shows its included equipment with quantities and photos", async () => {
    await page.getByTestId("package-card").nth(2).getByText("Choose Premium").click();
    await expect(page.getByRole("radio", { name: /^Premium/ })).toBeChecked();
    const included = page.locator("section", { has: page.getByRole("heading", { name: "What's included in Premium" }) });
    await expect(included.getByRole("listitem").filter({ hasText: "Uplights (pack of 4)" })).toContainText("2 included");
    await expect(included.getByRole("listitem").filter({ hasText: "Dance floor lighting" })).toContainText("No photo yet");
    // Photos below the fold load lazily: the missing file is only requested (and found missing) once in view.
    const mic = included.getByRole("listitem").filter({ hasText: "Wireless microphone" });
    await mic.scrollIntoViewIfNeeded();
    await expect(mic).toContainText("This photo couldn't load. Open it to try again.");
    await expect(page.getByText("All changes saved")).toBeVisible();
    await included.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    await shot(page, "03-selected-package-included-gear");

    // Comparison table: every package's quantities side by side.
    await page.getByText("Compare packages side by side").click();
    const row = page.getByRole("row", { name: /Additional-location speaker/ });
    await expect(row.getByRole("cell")).toHaveText(["—", "1", "2"]);
  });

  test("gallery: keyboard, Escape, focus return; photos keep proportions; video never autoplays", async () => {
    const opener = page.getByRole("button", { name: "View 4 photos and videos of Uplights (pack of 4)" }).first();
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Uplights (pack of 4): photos and videos" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await expect(dialog).toContainText("Photo 1 of 4");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Photo 2 of 4");
    await expect(dialog.getByRole("img", { name: "Four uplights washing a wall in purple" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    const tall = dialog.getByRole("img", { name: "A tall uplight, portrait photo" });
    await expect(tall).toHaveJSProperty("complete", true);
    // Portrait original (3000 x 4000) arrives resized with the same proportions: nothing cropped.
    const [w, h] = await tall.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
    expect(Math.abs(w / h - 0.75)).toBeLessThan(0.01);
    expect(h).toBeLessThanOrEqual(1600);
    await page.waitForLoadState("networkidle");
    await shot(page, "05-enlarged-gallery");

    // Tab never reaches the page behind the modal (it is inert); past the last
    // control, focus may go to the browser's own UI (document.body), then returns.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
    }
    await dialog.getByRole("button", { name: "Next" }).focus();

    const videoRequests = () => media.filter((m) => m.url.includes("/uplights_4/3")).length;
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Video 4 of 4");
    const video = dialog.locator("video");
    await expect(video).toHaveAttribute("controls", "");
    await expect(video).toHaveAttribute("preload", "none");
    expect(await video.evaluate((v: HTMLVideoElement) => [v.autoplay, v.paused])).toEqual([false, true]);
    await page.waitForTimeout(500);
    expect(videoRequests()).toBe(0);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(videoRequests).toBeGreaterThan(0);
    expect(media.find((m) => m.url.includes("/uplights_4/3"))!.status).toBe(302);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("answers add required equipment; included and extra quantities are never charged twice; exact totals", async () => {
    await page.getByRole("radio", { name: /^Signature/ }).check({ force: true });
    await page.getByRole("group", { name: /ceremony take place/ }).getByLabel("A separate space").check();
    await page.getByRole("group", { name: /cocktail hour/ }).getByLabel("A separate space").check();
    await page.getByRole("group", { name: /speeches/i }).getByLabel("Yes").check();

    const required = page.locator("section", { has: page.getByRole("heading", { name: "Required for your event" }) });
    const speaker = required.getByRole("listitem").filter({ hasText: "Additional-location speaker" }).first();
    await expect(speaker).toContainText("2 needed · 1 covered by your package");
    await expect(speaker).toContainText("DEMO: Your ceremony is in a separate space, so it needs its own speaker.");
    await expect(required.getByRole("listitem").filter({ hasText: "Wireless microphone" }).first()).toContainText("Already included in your package. Nothing extra to pay.");

    const stepper = page.getByRole("group", { name: "Additional-location speaker quantity" });
    await expect(stepper).toContainText("1");
    await expect(stepper.getByRole("button", { name: /^Fewer/ })).toBeDisabled();

    // Signature 2,200 + 1 required speaker 150 + 1 preselected uplights pack 120; taxes per line.
    const expected = priceSelection(offer, { package_key: "signature", addons: { uplights_4: 1 }, answers: { ceremony_location: "separate_space", cocktail_location: "separate_space", speeches_wireless_mic: true } });
    expect(expected.ok && expected.selection.total_cents).toBe(283_988);
    const summary = page.locator("#price-summary");
    await expect(summary).toContainText("Signature package$2,200.00");
    await expect(summary).toContainText("1 × Additional-location speaker (required)");
    await expect(summary).toContainText("GST (5%)$123.50");
    await expect(summary).toContainText("QST (9.975%)$246.38");
    await expect(summary).toContainText(`Total${formatCents(283_988)}`);
    await expect(summary).toContainText("Includes 1 × Additional-location speaker, 1 × Dance floor lighting, 1 × Main reception sound system, 2 × Wireless microphone at no extra charge.");
    await expect(summary).not.toContainText("Provisional");

    // Adding one more speaker charges 2 (the larger of choice and requirement), not 3.
    await stepper.getByRole("button", { name: /^More/ }).click();
    await expect(stepper).toContainText("2");
    await expect(summary).toContainText("2 × Additional-location speaker (required)$150.00 each$300.00");
    const speakerCard = extraCard(page, "Additional-location speaker");
    await expect(speakerCard).toContainText("Your package already includes 1.");
    await expect(speakerCard).toContainText("Required for your event: at least 1.");
    await expect(speakerCard).toContainText("Adds $300.00");
    await stepper.getByRole("button", { name: /^Fewer/ }).click();
    await expect(stepper).toContainText("1");
    await expect(page.getByText("All changes saved")).toBeVisible();

    await page.getByRole("heading", { name: "Optional extras" }).scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    await shot(page, "04-extras");
    await page.getByRole("heading", { name: "About your event" }).scrollIntoViewIfNeeded();
    await shot(page, "06-questions-and-price-summary");
  });

  test("phones (320, 390, landscape): three packages in one row, two-up gear cards, live total bar", async () => {
    const answers = { ceremony_location: "separate_space", cocktail_location: "separate_space", speeches_wireless_mic: true };
    const total = (package_key: string, addons: Record<string, number>, overrides: Record<string, unknown> = {}) => {
      const r = priceSelection(offer, { package_key, addons, answers: { ...answers, ...overrides } });
      if (!r.ok) throw new Error("unpriced");
      return formatCents(r.selection.total_cents);
    };
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const phone = await context.newPage();
      // A controllable visual viewport stands in for the on-screen keyboard.
      await phone.addInitScript(() => {
        const fake = Object.assign(new EventTarget(), { height: window.innerHeight, width: window.innerWidth });
        Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
        (window as unknown as { __keyboard: (open: boolean) => void }).__keyboard = (open) => {
          fake.height = open ? window.innerHeight * 0.5 : window.innerHeight;
          fake.dispatchEvent(new Event("resize"));
        };
      });
      await phone.setViewportSize(viewport);
      await phone.goto(url);
      const name = `${viewport.width}x${viewport.height}`;
      await expect(phone.getByRole("radio", { name: /^Signature/ }), name).toBeChecked();

      // All three package choices in one row, inside the screen.
      const cards = phone.getByTestId("package-card");
      const boxes = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
      expect(Math.abs(boxes[0].y - boxes[2].y), name).toBeLessThan(2);
      expect(boxes[2].x + boxes[2].width, name).toBeLessThanOrEqual(viewport.width);
      for (const i of [0, 1, 2]) {
        await expect(cards.nth(i).getByRole("heading")).toBeVisible();
        await expect(cards.nth(i).getByText(/^\$[\d,]+\.\d\d$/)).toBeVisible();
        const cta = (await cards.nth(i).locator("label").boundingBox())!;
        expect(cta.height).toBeGreaterThanOrEqual(44);
      }
      await expect(cards.nth(1).getByText("Recommended", { exact: true })).toBeVisible();
      expect(await noSideScroll(phone), name).toBeLessThanOrEqual(0);

      // Gear cards two per row.
      const included = phone.locator("section", { has: phone.getByRole("heading", { name: /What's included in/ }) }).locator(":scope > ul > li");
      const [g0, g1] = [(await included.nth(0).boundingBox())!, (await included.nth(1).boundingBox())!];
      expect(Math.abs(g0.y - g1.y), name).toBeLessThan(2);
      expect(g1.x + g1.width, name).toBeLessThanOrEqual(viewport.width);

      // The bar stays on screen while scrolling and shows the live total.
      const bar = phone.getByTestId("sticky-total");
      await phone.getByRole("heading", { name: "About your event" }).scrollIntoViewIfNeeded();
      await expect(bar).toBeInViewport();
      await expect(bar).toContainText("Total incl. tax");
      await expect(bar).toContainText(total("signature", { additional_location_speaker: 1, uplights_4: 1 }));
      await expect(bar.getByRole("button", { name: "Review proposal" })).toBeVisible();

      if (viewport.width === 390) {
        await phone.evaluate(() => window.scrollTo(0, 0));
        await phone.waitForLoadState("networkidle");
        await shot(phone, "12-phone-package-selection-390");
        await phone.getByRole("heading", { name: "Optional extras" }).scrollIntoViewIfNeeded();
        await phone.waitForLoadState("networkidle");
        await shot(phone, "13-phone-two-column-extras-390");

        // Changing a package, an extra and an answer updates the total at once; the save indicator is separate.
        await phone.getByRole("radio", { name: /^Premium/ }).check({ force: true });
        await expect(bar).toContainText(total("premium", { additional_location_speaker: 1, uplights_4: 1 }));
        await phone.getByRole("button", { name: "More Uplights (pack of 4)" }).click();
        await expect(bar).toContainText(total("premium", { additional_location_speaker: 1, uplights_4: 2 }));
        await expect(bar).toContainText(/Unsaved changes|Saving…/);
        await phone.getByRole("button", { name: "Fewer Uplights (pack of 4)" }).click();
        await expect(bar).toContainText(total("premium", { additional_location_speaker: 1, uplights_4: 1 }));
        // Essential includes no speaker: two separate spaces require two, one space requires one.
        await phone.getByRole("radio", { name: /^Essential/ }).check({ force: true });
        await expect(bar).toContainText(total("essential", { additional_location_speaker: 1, uplights_4: 1 }));
        await phone.getByRole("group", { name: /cocktail hour/ }).getByLabel("Same room as the reception").check();
        await expect(bar).toContainText(total("essential", { additional_location_speaker: 1, uplights_4: 1 }, { cocktail_location: "same_room" }));
        expect(total("essential", { additional_location_speaker: 1, uplights_4: 1 }, { cocktail_location: "same_room" })).not.toBe(total("essential", { additional_location_speaker: 1, uplights_4: 1 }));
        await phone.getByRole("group", { name: /cocktail hour/ }).getByLabel("A separate space").check();
        await phone.getByRole("radio", { name: /^Signature/ }).check({ force: true });
        await expect(bar).toContainText(total("signature", { additional_location_speaker: 1, uplights_4: 1 }));
        await expect(phone.getByText("All changes saved")).toBeAttached();
        await expect(bar).not.toContainText(/Unsaved|Saving/);
        await shot(phone, "14-phone-persistent-total-390");

        // Gallery from a small card, above the bar.
        await phone.getByRole("button", { name: "View 4 photos and videos of Uplights (pack of 4)" }).first().click();
        const close = phone.getByRole("button", { name: "Close" });
        await expect(close).toBeVisible();
        expect(Math.min((await close.boundingBox())!.width, (await close.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        await close.click();

        // Keyboard: hidden while open, back when it closes (even before the field loses focus).
        const notes = phone.getByRole("textbox", { name: /venue/i });
        await notes.focus();
        await phone.evaluate(() => (window as unknown as { __keyboard: (open: boolean) => void }).__keyboard(true));
        await expect(bar).toBeHidden();
        await phone.evaluate(() => (window as unknown as { __keyboard: (open: boolean) => void }).__keyboard(false));
        await expect(bar).toBeVisible();
        await notes.blur();

        // At the very end the bar settles below the last controls instead of covering them.
        await phone.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const last = (await phone.locator("#price-summary").getByRole("button", { name: "Review proposal" }).boundingBox())!;
        const barBox = (await bar.boundingBox())!;
        expect(barBox.y).toBeGreaterThanOrEqual(last.y + last.height);
      }
      expect(await noSideScroll(phone), name).toBeLessThanOrEqual(0);
      await phone.close();
    }
    // Phone saves moved the draft version on: reload so this tab continues without a conflict.
    await page.reload();
    await expect(page.getByRole("radio", { name: /^Signature/ })).toBeChecked();
  });

  test("slow and failed saves keep input; review opens only with saved choices", async () => {
    const notes = page.getByRole("textbox", { name: /venue/i });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    await page.route(`**${url}`, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"] || held) return route.continue();
      held = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await notes.fill("Loading dock behind the kitchen");
    await expect(page.locator("#price-summary").getByText("Saving…")).toBeVisible();
    await notes.fill("Loading dock behind the kitchen, stairs to the hall");
    release();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.unroute(`**${url}`);
    await expect(notes).toHaveValue("Loading dock behind the kitchen, stairs to the hall");

    // A failed save: the value stays, the status says so, and review refuses unsaved choices.
    await page.route(`**${url}`, (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
    await page.getByRole("button", { name: "More Uplights (pack of 4)" }).click();
    await expect(page.getByText(/Couldn't save your changes/)).toBeVisible();
    await expect(page.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("2");
    await page.getByRole("button", { name: "Review proposal" }).click();
    await expect(page.getByText(/Your latest choices aren't saved yet/)).toBeVisible();
    await expect(page.locator("#retry-save")).toBeFocused();
    await expect(page.getByRole("heading", { name: "Review your choices" })).toHaveCount(0);
    await page.unroute(`**${url}`);
    await page.getByRole("button", { name: "Retry saving" }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();

    await page.getByRole("button", { name: "Review proposal" }).click();
    await expect(page.getByRole("heading", { name: "Review your choices" })).toBeVisible();
    const { data: draft } = await must(admin.from("proposal_selection_drafts").select("package_key, addon_quantities, logistics_answers").eq("proposal_id", proposalId).single());
    expect(draft).toEqual({
      package_key: "signature",
      addon_quantities: { additional_location_speaker: 1, uplights_4: 2 },
      logistics_answers: { ceremony_location: "separate_space", cocktail_location: "separate_space", speeches_wireless_mic: true, venue_notes: "Loading dock behind the kitchen, stairs to the hall" },
    });
    const reviewed = priceSelection(offer, { package_key: draft!.package_key!, addons: draft!.addon_quantities as Record<string, number>, answers: draft!.logistics_answers as Record<string, unknown> });
    expect(reviewed.ok).toBe(true);
    await expect(page.getByRole("region", { name: "Your price" })).toContainText(`Total${formatCents(reviewed.ok ? reviewed.selection.total_cents : 0)}`);
    await expect(page.getByRole("region", { name: "Selected package" })).toContainText("Signature");
    await page.getByText("Your answers (4)").click();
    await expect(page.getByText("Loading dock behind the kitchen, stairs to the hall")).toBeVisible();
    await expect(page.getByText(/Submitting doesn't sign a contract, take a payment or confirm a booking/)).toBeVisible();
    await shot(page, "07-review", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "16-phone-review-390", true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Back to editing" }).click();
    await expect(page.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("2");
  });

  test("an ended session is explained on the page; reopening the link restores the saved choices", async () => {
    await must(admin.from("proposal_sessions").update({ revoked_at: new Date().toISOString() }).eq("proposal_id", proposalId).is("revoked_at", null));
    // A photo requested after access ended (the gallery's other photos were never loaded at this size).
    await page.getByRole("button", { name: "View photo of Additional-location speaker" }).first().click();
    await expect(page.getByText("Photo unavailable: your session has ended.").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alert").filter({ hasText: "Your session has ended" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More Uplights (pack of 4)" })).toBeDisabled();
    await expect(page.locator("#price-summary")).toContainText("Your session has ended.");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "08-session-ended");

    await openSession(context, tenant, proposalId, tokenHash);
    await page.reload();
    await expect(page.getByRole("group", { name: "Uplights (pack of 4) quantity" })).toContainText("2");
    await expect(page.getByRole("textbox", { name: /venue/i })).toHaveValue("Loading dock behind the kitchen, stairs to the hall");
  });

  test("media requests are refused without access, from another business, or for anything not in the offer", async ({ playwright }) => {
    const mediaUrl = `${url}/media/main_sound_system/0?w=400`;
    const anonymous = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000" });
    expect((await anonymous.get(mediaUrl)).status()).toBe(401);
    expect((await anonymous.head(mediaUrl)).status()).toBe(401);

    const cookie = (await context.cookies()).find((c) => c.name === "flux_proposal")!.value;
    const withCookie = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000", extraHTTPHeaders: { Cookie: `flux_proposal=${cookie}` } });
    const ok = await withCookie.get(mediaUrl);
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toBe("image/webp");
    expect(ok.headers()["cache-control"]).toBe("private, max-age=3600");
    expect((await withCookie.get(mediaUrl, { headers: { "If-None-Match": ok.headers()["etag"] } })).status()).toBe(304);
    // The same session against another business's address, or another business's proposal.
    expect((await withCookie.get(`/${other.slug}/proposals/${proposalId}/media/main_sound_system/0`)).status()).toBe(401);
    const theirs = await sendProposal(other, `E2E Other ${run}`);
    expect((await withCookie.get(`/${other.slug}/proposals/${theirs.proposalId}/media/main_sound_system/0`)).status()).toBe(401);
    // Only offer positions and fixed sizes: no paths, URLs or arbitrary sizes.
    for (const bad of ["/media/main_sound_system/7", "/media/not_in_offer/0", "/media/main_sound_system/0?w=5000", "/media/..%2F..%2Fsecret/0", `/media/main_sound_system/${encodeURIComponent("https://example.com/x.jpg")}`]) {
      expect((await withCookie.get(`${url}${bad}`)).status(), bad).toBe(404);
    }
    await anonymous.dispose();
    await withCookie.dispose();
  });

  test("staff preview uses the same resized media; another business's staff get nothing", async () => {
    const staffContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    const staffMedia: string[] = [];
    staff.on("response", (r) => {
      if (r.url().includes("/proposals/") && r.url().includes("/media/") && r.status() === 200 && r.request().method() === "GET") staffMedia.push(r.headers()["content-type"] ?? "");
    });
    await staff.goto(`/staff/${tenant.slug}/proposals/${proposalId}/preview`);
    await expect(staff.getByRole("radio", { name: /^Signature/ })).toBeChecked();
    await expect(staff.getByRole("button", { name: "Review proposal" })).toBeDisabled();
    await staff.waitForLoadState("networkidle");
    expect(staffMedia.length).toBeGreaterThan(0);
    expect(new Set(staffMedia)).toEqual(new Set(["image/webp"]));
    // Previewing changed nothing for the client.
    const { data: draft } = await must(admin.from("proposal_selection_drafts").select("addon_quantities").eq("proposal_id", proposalId).single());
    expect(draft!.addon_quantities).toEqual({ additional_location_speaker: 1, uplights_4: 2 });

    // The builder/sent view: the preview scrolls on its own, compactly, with its bar inside it.
    await staff.goto(`/staff/${tenant.slug}/proposals/${proposalId}`);
    const viewport = staff.getByTestId("preview-viewport");
    await expect(viewport).toBeVisible();
    const sizes = await viewport.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, page: document.documentElement.scrollHeight }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    expect(sizes.page).toBeLessThan(sizes.scroll);
    const cards = viewport.getByTestId("package-card");
    const [c0, c2] = [(await cards.nth(0).boundingBox())!, (await cards.nth(2).boundingBox())!];
    expect(Math.abs(c0.y - c2.y)).toBeLessThan(2);
    const frame = (await viewport.boundingBox())!;
    await viewport.evaluate((el) => (el.scrollTop = 1200));
    expect(await staff.evaluate(() => window.scrollY)).toBe(0);
    const bar = (await viewport.getByTestId("sticky-total").boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(frame.y);
    expect(bar.y + bar.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
    await viewport.evaluate((el) => (el.scrollTop = 0));
    // Scrolling the builder: the preview card sticks, and the whole preview (with its bar) fits the window.
    await staff.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(async () => { const b = (await viewport.boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(900);
    await expect(viewport.getByTestId("sticky-total")).toBeInViewport();
    await staff.waitForLoadState("networkidle");
    await shot(staff, "15-staff-contained-preview");
    await staff.evaluate(() => window.scrollTo(0, 0));
    await viewport.getByRole("button", { name: "View 4 photos and videos of Uplights (pack of 4)" }).first().click();
    const dialog = staff.getByRole("dialog", { name: "Uplights (pack of 4): photos and videos" });
    expect((await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(1270);
    await staff.keyboard.press("Escape");
    const unchanged = await must(admin.from("proposal_selection_drafts").select("addon_quantities").eq("proposal_id", proposalId).single());
    expect(unchanged.data!.addon_quantities).toEqual({ additional_location_speaker: 1, uplights_4: 2 });

    const otherStaff = await (await browser.newContext()).newPage();
    await signInStaff(otherStaff, other.ownerEmail);
    const refused = await otherStaff.request.get(`/staff/${tenant.slug}/proposals/${proposalId}/media/main_sound_system/0`);
    expect(refused.status()).toBe(404);
    const crossSlug = await otherStaff.request.get(`/staff/${other.slug}/proposals/${proposalId}/media/main_sound_system/0`);
    expect(crossSlug.status()).toBe(404);
    await otherStaff.context().close();
    await staffContext.close();
  });

  test("frozen names, prices, descriptions and photos survive catalog edits", async () => {
    const { data: gear } = await must(admin.from("gear_items").select("id, name, default_price_cents, description").eq("tenant_id", tenant.id).eq("key", "uplights_4").single());
    const { data: rows } = await must(admin.from("gear_media").select("id").eq("gear_item_id", gear!.id));
    await must(admin.from("gear_items").update({ name: "Renamed uplights", default_price_cents: 99_900, description: "Changed" }).eq("id", gear!.id));
    await must(admin.from("gear_media").update({ active: false }).in("id", rows!.map((r) => r.id)));
    try {
      await page.reload();
      const extra = extraCard(page, "Uplights (pack of 4)");
      await expect(extra).toContainText("$120.00 per pack");
      await expect(extra).toContainText("DEMO: one unit is four colour-matched uplights.");
      await expect(page.locator("body")).not.toContainText("Renamed uplights");
      await expect(page.locator("body")).not.toContainText("$999.00");
      await expect(extra.getByRole("button", { name: "View 4 photos and videos of Uplights (pack of 4)" })).toBeVisible();
      const img = extra.locator("img").first();
      await expect(img).toHaveJSProperty("complete", true);
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    } finally {
      await must(admin.from("gear_items").update({ name: gear!.name, default_price_cents: gear!.default_price_cents, description: gear!.description }).eq("id", gear!.id));
      await must(admin.from("gear_media").update({ active: true }).in("id", rows!.map((r) => r.id)));
    }
  });

  test("submitting once, with the saved choices, then the submitted view", async () => {
    await page.getByRole("button", { name: "Review proposal" }).click();
    await expect(page.getByRole("heading", { name: "Review your choices" })).toBeVisible();
    const submit = page.getByRole("button", { name: "Submit proposal" });
    await submit.dblclick();
    await expect(page.getByText("Submitted for DJ review.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/booking (is )?confirmed|you're booked|booked!/i);
    const { data: selections } = await must(admin.from("proposal_selections").select("total_cents, selection_snapshot").eq("proposal_id", proposalId));
    expect(selections).toHaveLength(1);
    const snapshot = selections![0].selection_snapshot as { addon_quantities: Record<string, number>; logistics_answers: Record<string, unknown> };
    expect(snapshot.addon_quantities).toEqual({ additional_location_speaker: 1, uplights_4: 2 });
    expect(snapshot.logistics_answers.venue_notes).toBe("Loading dock behind the kitchen, stairs to the hall");
    const expected = priceSelection(offer, { package_key: "signature", addons: snapshot.addon_quantities, answers: snapshot.logistics_answers });
    expect(expected.ok && selections![0].total_cents).toBe(expected.ok ? expected.selection.total_cents : -1);
    await expect(page.getByText(formatCents(selections![0].total_cents)).first()).toBeVisible();
    await shot(page, "09-submitted", true);

    await page.reload();
    await expect(page.getByText("Submitted for DJ review.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Submit/ })).toHaveCount(0);
  });

  test("expired and unavailable proposals are clear and read-only", async () => {
    const expired = await sendProposal(tenant, `E2E Expired Wedding ${run}`);
    await must(admin.from("proposals").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", expired.proposalId));
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await openSession(ctx, tenant, expired.proposalId, expired.tokenHash);
    const p = await ctx.newPage();
    await p.goto(`/${tenant.slug}/proposals/${expired.proposalId}`);
    await expect(p.getByRole("alert").filter({ hasText: "This proposal has expired" })).toBeVisible();
    await expect(p.getByRole("radio", { name: /^Signature/ })).toBeDisabled();
    await expect(p.getByRole("button", { name: "Review proposal" })).toHaveCount(0);
    await expect(p.getByTestId("sticky-total")).toHaveCount(0);
    await shot(p, "10-expired");

    const stranger = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const s = await stranger.newPage();
    await s.goto(url);
    await expect(s.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
    await expect(s.locator("body")).not.toContainText(`E2E Experience Wedding ${run}`);
    expect(await noSideScroll(s)).toBeLessThanOrEqual(0);
    await shot(s, "11-unavailable-link");
    await ctx.close();
    await stranger.close();
  });
});
