/**
 * Package photos in real browsers, in dedicated test businesses: creating a
 * package with a photo (wrong types and oversized files refused before
 * anything is saved), adding, replacing (contents verified) and removing a
 * photo, the list thumbnail, the draft preview and the client's proposal
 * showing the package's own photo (filling its card, enlargeable to the
 * whole photo; desktop and phone), a sent proposal
 * keeping its photo after replacement while a new revision shows the new
 * one, removal falling back to the gear photo, and another business getting
 * nothing.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { must, sessionFor } from "./booking";
import { admin, signInStaff } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { htmlDisguisedAsPng, opaqueJpeg, opaqueWebp, transparentPng } from "../support/logo-fixtures";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const loaded = (img: Locator) => expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

test.describe.serial("package photos", () => {
  let browser: Browser;
  let tenant: TestTenant;
  let other: TestTenant;
  const run = randomUUID().slice(0, 6);
  let signature = "";
  let eventId = "";
  let firstProposal = { id: "", tokenHash: "" };

  const photos = async (packageId: string) =>
    (await must(admin.from("package_media").select("storage_path, content_type, alt_text, active").eq("package_id", packageId).order("created_at"))).data!;
  const stored = async (packageId: string) => (await must(admin.storage.from("gear-media").list(`${tenant.id}/packages/${packageId}`))).data!.length;

  async function staffPage(t: TestTenant, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 1000 } }) {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, t.ownerEmail);
    return page;
  }

  /** A proposal session exactly as /p/exchange creates one, set as the browser's cookie. */
  async function clientContext(proposalId: string, tokenHash: string, options: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1280, height: 900 } }): Promise<BrowserContext> {
    const token = randomBytes(32).toString("base64url");
    const { data } = await must(admin.rpc("exchange_proposal_link", { p_token_hash: tokenHash, p_session_hash: sha256(token), p_tenant_slug: tenant.slug, p_session_seconds: 3600 }));
    expect((data as { status: string }).status).toBe("ok");
    const context = await browser.newContext(options);
    await context.addCookies([{ name: "flux_proposal", value: token, domain: "127.0.0.1", path: `/${tenant.slug}/proposals/${proposalId}`, httpOnly: true, sameSite: "Lax" }]);
    return context;
  }

  /** Opens the event's draft (or a revision) from "Wedding (DEMO)" and sends it as staff. */
  async function sendRevision(): Promise<{ id: string; tokenHash: string }> {
    const staffDb = await sessionFor(tenant.ownerEmail);
    const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
    const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
    const { data: id } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input }));
    const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", id).single());
    const tokenHash = sha256(randomBytes(32).toString("base64url"));
    await must(staffDb.rpc("send_proposal", { p_proposal_id: id, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: tokenHash }));
    return { id: id as string, tokenHash };
  }

  async function choosePhoto(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, description?: string) {
    await page.getByLabel("Photo", { exact: true }).setInputFiles(file);
    if (description) await page.getByLabel("Photo description (optional)").fill(description);
    await page.getByRole("button", { name: "Save photo" }).click();
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("pkgphoto", { catalog: true });
    other = await createTestTenant("pkgphoto-other", { catalog: true });
    signature = (await must(admin.from("packages").select("id").eq("tenant_id", tenant.id).eq("key", "signature").single())).data!.id;
    // A gear photo on the main sound system: the fallback for packages without their own photo.
    const { data: main } = await must(admin.from("gear_items").select("id").eq("tenant_id", tenant.id).eq("key", "main_sound_system").single());
    const path = `${tenant.id}/gear-items/${main!.id}/${randomUUID()}.jpg`;
    await must(admin.storage.from("gear-media").upload(path, await opaqueJpeg(400, 300), { contentType: "image/jpeg" }));
    await must(admin.from("gear_media").insert({ tenant_id: tenant.id, gear_item_id: main!.id, storage_path: path, kind: "image", content_type: "image/jpeg", alt_text: "Two black speakers" }));
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Photo Client", email: `e2e-pkgphoto-${run}@example.test` }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `Photo wedding ${run}`, event_type: "wedding", event_date: "2027-09-25", venue_name: "E2E Hall" }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
    await archiveTestTenant(other);
  });

  test("create a package with a photo; wrong types and oversized files are refused first; the list shows it", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/new`);
    const picker = page.getByTestId("package-photo-picker");
    await expect(page.getByText("Choose a photo that represents this package. It will appear on client proposals.")).toBeVisible();
    const name = `E2E Full setup ${run}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Base price (CAD)").fill("1800");

    await page.getByLabel("Photo (optional)").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") });
    await expect(picker.getByRole("alert")).toHaveText("Choose a JPEG, PNG, WebP or AVIF photo.");
    await page.getByLabel("Photo (optional)").setInputFiles({ name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(16 * 1024 * 1024, 1) });
    await expect(picker.getByRole("alert")).toHaveText("That file is 16.0 MB. Photos can be up to 15.0 MB.");
    await expect(picker.locator("img")).toHaveCount(0);
    await page.getByLabel("Photo (optional)").setInputFiles({ name: "thumb.jpg", mimeType: "image/jpeg", buffer: await opaqueJpeg(380, 280) });
    await expect(picker.getByRole("alert")).toHaveText("This photo is too small (380 × 280 pixels). Choose a higher-resolution photo, at least 400 × 300 pixels.");
    await expect(picker.locator("img")).toHaveCount(0);

    await page.getByLabel("Photo (optional)").setInputFiles({ name: "setup.jpg", mimeType: "image/jpeg", buffer: await opaqueJpeg(800, 600) });
    await expect(picker.getByRole("alert")).toHaveCount(0);
    // Accepted, with a note: 800 pixels looks soft full screen.
    await expect(picker.getByRole("status")).toHaveText(/may appear blurry when enlarged/);
    await loaded(picker.locator("img"));
    await page.getByLabel("Photo description (optional)").fill("Complete DJ setup at a reception");
    await page.getByRole("button", { name: "Save package" }).click();
    await page.waitForURL(/\/packages\/[0-9a-f-]{36}\?created=1$/);
    await expect(page.getByText("Package created.")).toBeVisible();
    const id = /\/packages\/([0-9a-f-]{36})\?/.exec(page.url())![1];
    expect(await photos(id)).toEqual([expect.objectContaining({ content_type: "image/jpeg", alt_text: "Complete DJ setup at a reception", active: true })]);
    const current = page.getByTestId("package-photo-current");
    await loaded(current.getByRole("img", { name: "Complete DJ setup at a reception" }));

    await page.goto(`/staff/${tenant.slug}/packages?q=${encodeURIComponent(name)}`);
    await loaded(page.getByTestId("package-row").locator("img"));

    // Without a photo the form saves exactly as before; its row has the placeholder.
    await page.goto(`/staff/${tenant.slug}/packages/new`);
    await page.getByLabel("Name").fill(`E2E No photo ${run}`);
    await page.getByLabel("Base price (CAD)").fill("900");
    await page.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByText("Package created.")).toBeVisible();
    await expect(page.getByTestId("package-photo-none")).toBeVisible();
    await expect(page.getByText("No package photo yet.")).toBeVisible();
    const plain = /\/packages\/([0-9a-f-]{36})\?/.exec(page.url())![1];
    expect(await photos(plain)).toEqual([]);
    await page.context().close();
  });

  test("add a photo to an existing package; the draft preview and the client's proposal show it", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/${signature}`);
    await expect(page.getByTestId("package-photo-none")).toBeVisible();
    await page.getByRole("button", { name: "Add photo" }).click();
    await choosePhoto(page, { name: "a.png", mimeType: "image/png", buffer: await transparentPng(900, 600) }, "Photo A: speakers and lights");
    await expect(page.getByRole("status").filter({ hasText: "Photo saved. It appears on new proposals." })).toBeVisible();
    await loaded(page.getByTestId("package-photo-current").getByRole("img", { name: "Photo A: speakers and lights" }));

    // The draft's client preview: Signature shows its own photo; the others keep the gear photo.
    await page.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await page.getByLabel("Start from template").selectOption({ label: "Wedding (DEMO)" });
    await page.getByRole("button", { name: "Start proposal draft" }).click();
    await page.waitForURL("**/proposals/**");
    const cards = page.getByTestId("package-card");
    await expect(cards).toHaveCount(3);
    await loaded(cards.nth(1).getByTestId("package-photo").getByRole("img", { name: "Photo A: speakers and lights" }));
    await expect(cards.nth(0).getByTestId("package-photo")).toHaveCount(0);
    await expect(cards.nth(0).getByRole("button", { name: /^View photo of / })).toBeVisible();
    await page.getByRole("button", { name: "Review and send…" }).click();
    await page.getByRole("dialog", { name: "Confirm sending" }).getByRole("button", { name: "Send proposal now" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    // The frozen offer on the staff page shows it too.
    await loaded(page.getByTestId("package-card").nth(1).getByRole("img", { name: "Photo A: speakers and lights" }));
    const proposalId = page.url().split("/").pop()!;
    await page.context().close();

    // The client's page (a link session, as opening the emailed link creates).
    const tokenHash = (await must(admin.from("access_links").select("token_hash").eq("proposal_id", proposalId).single())).data!.token_hash as string;
    firstProposal = { id: proposalId, tokenHash };
    const context = await clientContext(proposalId, tokenHash);
    const client = await context.newPage();
    const served: { status: number; type: string }[] = [];
    client.on("response", (r) => {
      if (r.url().includes("/package-media/signature")) served.push({ status: r.status(), type: r.headers()["content-type"] ?? "" });
    });
    await client.goto(`/${tenant.slug}/proposals/${proposalId}`);
    const clientCards = client.getByTestId("package-card");
    const photo = clientCards.nth(1).getByRole("img", { name: "Photo A: speakers and lights" });
    await loaded(photo);
    // A setup fills its card's frame (cropped from the centre, not stretched or letterboxed).
    expect(await photo.evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("cover");
    const frame = (await clientCards.nth(1).getByTestId("package-photo").boundingBox())!;
    const box = (await photo.boundingBox())!;
    expect(Math.abs(box.width - frame.width) + Math.abs(box.height - frame.height)).toBeLessThan(2);
    // Enlarged, it is shown whole.
    await clientCards.nth(1).getByRole("button", { name: "View photo of Signature" }).click();
    const viewer = client.getByRole("dialog", { name: "Signature: photo" });
    const whole = viewer.getByRole("img", { name: "Photo A: speakers and lights" });
    await loaded(whole);
    expect(await whole.evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("contain");
    await expect(viewer.getByRole("button", { name: "Next" })).toHaveCount(0);
    await client.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(clientCards.nth(1).getByRole("button", { name: "View photo of Signature" })).toBeFocused();
    expect(served.some((s) => s.status === 200 && s.type === "image/webp")).toBe(true);
    await expect(clientCards.nth(0).getByTestId("package-photo")).toHaveCount(0);
    await context.close();

    // On a phone: three cards in a row, the photo loads, nothing scrolls sideways.
    const phone = await clientContext(proposalId, tokenHash, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const small = await phone.newPage();
    await small.goto(`/${tenant.slug}/proposals/${proposalId}`);
    await loaded(small.getByTestId("package-card").nth(1).getByRole("img", { name: "Photo A: speakers and lights" }));
    expect(await sideways(small)).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("replacing: contents are verified, the sent proposal keeps photo A, a new revision shows photo B", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/${signature}`);
    await page.getByRole("button", { name: "Replace photo" }).click();
    // HTML renamed to .png: refused by its contents, the upload is discarded, photo A stays.
    await choosePhoto(page, { name: "evil.png", mimeType: "image/png", buffer: htmlDisguisedAsPng() });
    await expect(page.getByTestId("package-photo-editor").getByRole("alert")).toHaveText("Not saved: That file's contents are not a supported image or video.");
    expect((await photos(signature)).map((p) => p.active)).toEqual([true]);
    expect(await stored(signature)).toBe(1);
    // A wide panorama (3:1).
    await page.getByLabel("Photo", { exact: true }).setInputFiles({ name: "b.webp", mimeType: "image/webp", buffer: await opaqueWebp(1800, 600) });
    await page.getByLabel("Photo description (optional)").fill("Photo B: the full rig");
    await page.getByRole("button", { name: "Save photo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Photo saved." })).toBeVisible();
    await loaded(page.getByTestId("package-photo-current").getByRole("img", { name: "Photo B: the full rig" }));
    const rows = await photos(signature);
    expect(rows.map((r) => [r.alt_text, r.active])).toEqual([["Photo A: speakers and lights", false], ["Photo B: the full rig", true]]);
    expect(await stored(signature)).toBe(2);
    await page.context().close();

    // The sent proposal still shows A (and the staff view of it too).
    const context = await clientContext(firstProposal.id, firstProposal.tokenHash);
    const client = await context.newPage();
    await client.goto(`/${tenant.slug}/proposals/${firstProposal.id}`);
    await loaded(client.getByTestId("package-card").nth(1).getByRole("img", { name: "Photo A: speakers and lights" }));
    await expect(client.getByRole("img", { name: "Photo B: the full rig" })).toHaveCount(0);
    await context.close();

    // A new revision freezes B.
    const revision = await sendRevision();
    const next = await clientContext(revision.id, revision.tokenHash);
    const nextPage = await next.newPage();
    await nextPage.goto(`/${tenant.slug}/proposals/${revision.id}`);
    const wide = nextPage.getByTestId("package-card").nth(1).getByRole("img", { name: "Photo B: the full rig" });
    await loaded(wide);
    // No bars above and below: the wide photo covers its 4:3 frame.
    const wideFrame = (await nextPage.getByTestId("package-card").nth(1).getByTestId("package-photo").boundingBox())!;
    expect(Math.abs((await wide.boundingBox())!.height - wideFrame.height)).toBeLessThan(2);
    expect(await wide.evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit)).toBe("cover");
    await next.close();
    const staff = await staffPage(tenant);
    await staff.goto(`/staff/${tenant.slug}/proposals/${firstProposal.id}`);
    await loaded(staff.getByTestId("package-card").nth(1).getByRole("img", { name: "Photo A: speakers and lights" }));
    await staff.context().close();
  });

  test("removing falls back to the gear photo on new proposals; the files are kept", async () => {
    const page = await staffPage(tenant);
    await page.goto(`/staff/${tenant.slug}/packages/${signature}`);
    await page.getByRole("button", { name: "Remove photo" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm removing the package photo" });
    await expect(dialog).toContainText("Proposals already sent keep this photo.");
    await dialog.getByRole("button", { name: "Remove photo" }).click();
    await expect(page.getByText("Photo removed from new proposals. Proposals already sent keep it.")).toBeVisible();
    await expect(page.getByTestId("package-photo-none")).toBeVisible();
    expect((await photos(signature)).every((p) => !p.active)).toBe(true);
    expect(await stored(signature)).toBe(2);

    const revision = await sendRevision();
    const context = await clientContext(revision.id, revision.tokenHash);
    const client = await context.newPage();
    await client.goto(`/${tenant.slug}/proposals/${revision.id}`);
    const card = client.getByTestId("package-card").nth(1);
    await expect(card.getByTestId("package-photo")).toHaveCount(0);
    await loaded(card.getByRole("button", { name: "View photo of Main reception sound system" }).locator("img"));
    await context.close();
    await page.context().close();
  });

  test("another business gets nothing: no page, no photo, no staff media", async () => {
    const outsider = await staffPage(other);
    expect((await outsider.goto(`/staff/${tenant.slug}/packages/${signature}`))?.status()).toBe(404);
    const media = await outsider.request.get(`/staff/${other.slug}/proposals/${firstProposal.id}/package-media/signature`);
    expect(media.status()).toBe(404);
    const theirs = await outsider.request.get(`/staff/${tenant.slug}/proposals/${firstProposal.id}/package-media/signature`);
    expect(theirs.status()).toBe(404);
    await outsider.context().close();

    // Without a proposal session: refused.
    const anon = await browser.newContext();
    const refused = await anon.request.get(`/${tenant.slug}/proposals/${firstProposal.id}/package-media/signature`);
    expect(refused.status()).toBe(401);
    await anon.close();
  });
});
