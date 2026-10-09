/**
 * The client home (/my) and contract pages in real browsers: events at two
 * businesses in different states, the recommended action for the signer and
 * for another person with access, the contract overview, payments, signing,
 * the signed PDF, and the refusals (signed out, archived, suspended, another
 * person's contract).
 *
 * Fixtures go through the same database functions the app uses (the staff
 * screens that create them are covered by their own specs). Dedicated e2e
 * tenants only; sign-in uses signInWithLink (no sign-in form, no rate limit).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { must, sessionFor } from "./booking";
import { admin, signInWithLink } from "./support";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";
import { archiveTestTenant, createTestTenant, publishContractTemplate, submitAsClient, type TestTenant } from "./tenant";

const REVIEW_DIR = "review-samples/client-home-contract";
const run = randomUUID().slice(0, 6);
const signerEmail = `e2e-home-signer-${run}@example.test`;
const viewerEmail = `e2e-home-viewer-${run}@example.test`;
const emptyEmail = `e2e-home-empty-${run}@example.test`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${REVIEW_DIR}/${name}.png`, fullPage });

type Fixture = { tenant: TestTenant; signerClientId: string; templateVersionId: string };

async function setUpTenant(suite: string, primary: string): Promise<Fixture> {
  const tenant = await createTestTenant(suite, { catalog: true });
  await must(admin.from("tenants").update({ brand_colors: { primary } }).eq("id", tenant.id));
  const signerClientId = randomUUID();
  await must(admin.from("clients").insert({ id: signerClientId, tenant_id: tenant.id, name: "Jordan Lee", email: signerEmail }));
  const templateVersionId = await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
    { heading: "Parties", body: "{{business.legal_name}}\nClient: {{client.name}}" },
    { heading: "Services", body: "DEMO: DJ and sound for the reception.\nSetup two hours before guests arrive." },
    { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
  ]);
  return { tenant, signerClientId, templateVersionId };
}

async function newEvent(f: Fixture, title: string, date: string, venue: string | null): Promise<string> {
  const eventId = randomUUID();
  await must(admin.from("events").insert({ id: eventId, tenant_id: f.tenant.id, title, event_type: "wedding", event_date: date, venue_name: venue, internal_notes: `Staff-only note ${run}` }));
  await must(admin.from("event_clients").insert({ tenant_id: f.tenant.id, event_id: eventId, client_id: f.signerClientId, is_primary: true, can_sign: true }));
  return eventId;
}

/** Proposal sent, submitted and approved; contract generated, sent and accepted by the signer; then optionally signed and booked. */
async function contractFor(f: Fixture, eventId: string, signerUserId: string, stage: "sent" | "signed" | "booked", opts: { keepPdfJob?: boolean } = {}): Promise<string> {
  const staffDb = await sessionFor(f.tenant.ownerEmail);
  const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", f.tenant.id).eq("name", "Wedding (DEMO)").single());
  const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
  const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input }));
  const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
  await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: randomUUID().replaceAll("-", "").repeat(2) }));
  await submitAsClient(f.tenant, proposalId as string);
  const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).not("submitted_at", "is", null).single());
  const { data: approval } = await must(staffDb.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));
  const { data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: f.templateVersionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));
  const clientDb = await sessionFor(signerEmail);
  await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: f.tenant.slug }));
  if (stage === "sent") return contractId;

  const { data: c } = await must(admin.from("contracts").select("content_sha256, consent_version, deposit_cents").eq("id", contractId).single());
  const path = `${f.tenant.id}/${contractId}/${randomUUID()}.png`;
  await must(admin.storage.from("contract-signatures").upload(path, PNG, { contentType: "image/png" }));
  const { data: signed } = await must(admin.rpc("sign_contract", {
    p_contract_id: contractId, p_tenant_slug: f.tenant.slug, p_user_id: signerUserId, p_typed_name: "Jordan Lee",
    p_content_sha256: c!.content_sha256, p_consent_version: c!.consent_version, p_consent_accepted: true, p_signature_path: path,
    p_signature_sha256: createHash("sha256").update(PNG).digest("hex"), p_signature_bytes: PNG.length, p_signature_width: 1, p_signature_height: 1,
    p_user_agent: "E2E", p_client_ip: null, p_client_ip_source: "unavailable",
  }));
  expect((signed as { status: string }).status).toBe("signed");
  if (!opts.keepPdfJob) {
    // Not needed here; retired so other signing specs never wait behind it.
    const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
    for (const j of (jobs ?? []) as { job_id: string; lease_token: string }[]) {
      await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "client home e2e: PDF not needed", p_permanent: true });
    }
  }
  if (stage === "booked") {
    const { data: paid } = await must(staffDb.rpc("record_event_payment", {
      p_event_id: eventId, p_amount_cents: c!.deposit_cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      p_reference: `E2E-PAYMENT-REF-SECRET-${run}`, p_note: `E2E staff payment note ${run}`, p_idempotency_key: randomUUID(), p_confirm_duplicate: false,
    }));
    expect((paid as { booking: string }).booking).toBe("booked");
  }
  return contractId;
}

/** Ink pixels currently on the signature canvas. */
const inkOn = (page: Page) =>
  page.getByTestId("signature-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    return ink;
  });

async function drawWithMouse(page: Page) {
  const box = (await page.getByTestId("signature-canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + box.width * (0.12 + 0.025 * i), box.y + box.height * (0.5 + 0.25 * Math.sin(i / 2.5)));
  await page.mouse.up();
}

test.describe.serial("client home and contract", () => {
  let browser: Browser;
  let a: Fixture;
  let b: Fixture;
  let signerContext: BrowserContext;
  let signer: Page;
  const ev: Record<"unsigned" | "deposit" | "booked" | "past" | "soon", { id: string; title: string; contractId?: string }> = {
    unsigned: { id: "", title: `E2E Unsigned Wedding ${run}` },
    deposit: { id: "", title: `E2E Deposit Wedding ${run}` },
    booked: { id: "", title: `E2E Booked Wedding ${run}` },
    past: { id: "", title: `E2E Past Party ${run}` },
    soon: { id: "", title: `E2E Other DJ Gala ${run}` },
  };

  test.beforeAll(async ({ browser: br }) => {
    test.setTimeout(180_000);
    browser = br;
    mkdirSync(REVIEW_DIR, { recursive: true });
    [a, b] = await Promise.all([setUpTenant("home-a", "#6d28d9"), setUpTenant("home-b", "#0f766e")]);
    const { data: signerUser } = await must(admin.auth.admin.createUser({ email: signerEmail, email_confirm: true }));
    const signerId = signerUser.user!.id;
    await must(admin.auth.admin.createUser({ email: emptyEmail, email_confirm: true }));

    ev.unsigned.id = await newEvent(a, ev.unsigned.title, dayFromNow(200), "Le Grand Salon, Montréal");
    ev.deposit.id = await newEvent(a, ev.deposit.title, dayFromNow(150), null);
    ev.booked.id = await newEvent(a, ev.booked.title, dayFromNow(100), "Harbourfront Hall");
    ev.past.id = await newEvent(a, ev.past.title, dayFromNow(-60), "Old Mill");
    ev.soon.id = await newEvent(b, ev.soon.title, dayFromNow(7), "Gallery 7");
    ev.unsigned.contractId = await contractFor(a, ev.unsigned.id, signerId, "sent");
    ev.deposit.contractId = await contractFor(a, ev.deposit.id, signerId, "signed", { keepPdfJob: true });
    ev.booked.contractId = await contractFor(a, ev.booked.id, signerId, "booked");
    ev.soon.contractId = await contractFor(b, ev.soon.id, signerId, "booked");
    // The past event: access only (a lead with no contract).
    await must(admin.from("event_access").insert({ tenant_id: a.tenant.id, event_id: ev.past.id, client_id: a.signerClientId, user_id: signerId }));

    // Another person on two of the events, with access but not the signer.
    const viewerClient = randomUUID();
    const { data: viewer } = await must(admin.auth.admin.createUser({ email: viewerEmail, email_confirm: true }));
    await must(admin.from("clients").insert({ id: viewerClient, tenant_id: a.tenant.id, name: "Sam Lee", email: viewerEmail }));
    for (const id of [ev.deposit.id, ev.booked.id]) {
      await must(admin.from("event_clients").insert({ tenant_id: a.tenant.id, event_id: id, client_id: viewerClient, is_primary: false, can_sign: false }));
      await must(admin.from("event_access").insert({ tenant_id: a.tenant.id, event_id: id, client_id: viewerClient, user_id: viewer.user!.id }));
    }

    signerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    signer = await signerContext.newPage();
    await signInWithLink(signer, signerEmail, "/my");
  });

  test.afterAll(async () => {
    await signerContext?.close();
    await archiveTestTenant(a?.tenant);
    await archiveTestTenant(b?.tenant);
  });

  test("an account with no events gets a clear empty state", async () => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await signInWithLink(page, emptyEmail, "/my");
    await page.waitForURL("**/my");
    await expect(page.getByRole("heading", { name: "No events yet" })).toBeVisible();
    await expect(page.getByText(/has no contracts to read yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.context().close();
  });

  test("desktop: events at two businesses, each with its own branding, status and next action", async () => {
    await signer.goto("/my");
    await expect(signer.getByRole("heading", { level: 1, name: "Your events" })).toBeVisible();
    // Neutral page identity: the Flux wordmark, no business name in the top bar.
    await expect(signer.getByRole("link", { name: "Flux DJ home" })).toBeVisible();
    await expect(signer.locator("header")).not.toContainText(a.tenant.displayName);

    const card = (title: string) => signer.getByRole("listitem").filter({ has: signer.getByRole("heading", { name: title }) });
    const upcoming = signer.locator("section", { has: signer.getByRole("heading", { name: "Upcoming" }) }).getByRole("heading", { level: 3 });
    await expect(upcoming).toHaveText([ev.soon.title, ev.booked.title, ev.deposit.title, ev.unsigned.title]);

    await expect(card(ev.unsigned.title).getByTestId("event-status")).toHaveText("Contract ready to sign");
    await expect(card(ev.unsigned.title).getByRole("link", { name: `Review and sign contract for ${ev.unsigned.title}` })).toHaveAttribute("href", `/${a.tenant.slug}/contracts/${ev.unsigned.contractId}`);
    await expect(card(ev.unsigned.title)).toContainText("Le Grand Salon, Montréal");

    await expect(card(ev.deposit.title).getByTestId("event-status")).toHaveText("Signed · awaiting deposit");
    await expect(card(ev.deposit.title).getByRole("link", { name: `View deposit details for ${ev.deposit.title}` })).toBeVisible();
    await expect(card(ev.deposit.title)).toContainText("Your signed PDF is being prepared.");

    await expect(card(ev.booked.title).getByTestId("event-status")).toHaveText("Booked");
    await expect(card(ev.booked.title).getByRole("link", { name: `Plan your event for ${ev.booked.title}` })).toHaveAttribute("href", `/${a.tenant.slug}/planning/${ev.booked.id}`);
    await expect(card(ev.booked.title).getByRole("link", { name: `View signed contract for ${ev.booked.title}` })).toBeVisible();

    // The other business's event, a week away: client planning edits have closed (14-day default).
    await expect(card(ev.soon.title)).toContainText(b.tenant.displayName);
    await expect(card(ev.soon.title).getByRole("link", { name: `View planning for ${ev.soon.title}` })).toBeVisible();
    await expect(card(ev.soon.title)).toContainText("Planning is closed for changes.");

    // Each card carries its own business's colour.
    const stripe = (title: string) => card(title).locator("div[aria-hidden]").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await stripe(ev.booked.title)).toBe("rgb(109, 40, 217)");
    expect(await stripe(ev.soon.title)).toBe("rgb(15, 118, 110)");

    // Past events are secondary.
    const pastToggle = signer.getByText("Past events (1)");
    await expect(pastToggle).toBeVisible();
    await expect(signer.getByRole("heading", { name: ev.past.title })).toBeHidden();
    await pastToggle.click();
    await expect(card(ev.past.title).getByTestId("event-status")).toHaveText("Proposal stage");

    await expect(signer.locator("body")).not.toContainText(new RegExp(`pay now|Staff-only note ${run}|E2E-PAYMENT-REF-SECRET|staff payment note`, "i"));
    await pastToggle.click();
    await shot(signer, "01-client-home-desktop");
    await shot(signer, "02-multiple-businesses", true);
  });

  test("phones (390 and 320): no sideways scrolling, full-width actions", async () => {
    for (const width of [390, 320]) {
      const phone = await signerContext.newPage();
      await phone.setViewportSize({ width, height: 800 });
      await phone.goto("/my");
      await expect(phone.getByRole("heading", { level: 1, name: "Your events" })).toBeVisible();
      expect(await noSideways(phone)).toBeLessThanOrEqual(0);
      const action = phone.getByRole("link", { name: `Review and sign contract for ${ev.unsigned.title}` });
      const box = (await action.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      if (width === 390) await shot(phone, "03-client-home-phone-390", true);
      await phone.close();
    }
  });

  test("someone with access who isn't the signer: statuses and planning, never signing or contract links", async () => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await signInWithLink(page, viewerEmail, "/my");
    await page.waitForURL("**/my");
    const card = (title: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
    await expect(card(ev.deposit.title).getByTestId("event-status")).toHaveText("Signed · awaiting deposit");
    await expect(card(ev.deposit.title).getByRole("link")).toHaveCount(0);
    await expect(card(ev.booked.title).getByRole("link", { name: `Plan your event for ${ev.booked.title}` })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/sign it|Review and sign|deposit still to pay|View deposit/i);
    await expect(page.getByRole("heading", { name: ev.unsigned.title })).toHaveCount(0);
    // The signer's contract stays closed to them.
    await page.goto(`/${a.tenant.slug}/contracts/${ev.booked.contractId}`);
    await expect(page.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
    await page.context().close();
  });

  test("unsigned contract: overview, the full agreement and terms, then signing with validation and kept input", async () => {
    const url = `/${a.tenant.slug}/contracts/${ev.unsigned.contractId}`;
    await signer.goto(url);
    await expect(signer.getByRole("heading", { level: 1 })).toHaveText(`DEMO, NOT FOR CLIENT USE: Agreement for ${ev.unsigned.title}`);
    await expect(signer.getByText("DEMO, NOT FOR CLIENT USE. This is test wording, not a real agreement.")).toBeVisible();
    await expect(signer.getByRole("region", { name: "Contract overview" })).toContainText("Ready to sign");
    await expect(signer.getByRole("region", { name: "Contract overview" })).toContainText("Le Grand Salon, Montréal");
    const agreement = signer.getByRole("article");
    for (const heading of ["Parties", "Services", "Payment"]) await expect(agreement.getByRole("heading", { name: heading })).toBeVisible();
    await expect(agreement).toContainText("Setup two hours before guests arrive.");
    await expect(signer.getByRole("region", { name: "Payments" })).toContainText("Deposit on signing (50%)");
    await expect(signer.getByRole("checkbox")).not.toBeChecked();
    await expect(signer.getByRole("link", { name: "Your events", exact: true })).toBeVisible();
    await shot(signer, "04-unsigned-contract");

    await signer.getByRole("link", { name: "Go to signing" }).click();
    await signer.getByRole("button", { name: "Review and sign…" }).click();
    await expect(signer.getByRole("alert").filter({ hasText: "To sign" })).toContainText("To sign, type your full name, draw your signature, check the consent box.");
    await expect(signer.getByLabel("Your full name")).toHaveAttribute("aria-invalid", "true");
    await signer.getByRole("region", { name: "Sign this contract" }).scrollIntoViewIfNeeded();
    await shot(signer, "05-signing-validation");

    await signer.getByLabel("Your full name").fill("Jordan Lee");
    await drawWithMouse(signer);
    const ink = await inkOn(signer);
    expect(ink).toBeGreaterThan(200);
    // Resizing keeps the drawing (strokes are rescaled).
    await signer.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => inkOn(signer)).toBeGreaterThan(50);
    expect(await noSideways(signer)).toBeLessThanOrEqual(0);
    await signer.getByRole("region", { name: "Sign this contract" }).scrollIntoViewIfNeeded();
    await shot(signer, "06-signing-form-phone");
    await signer.setViewportSize({ width: 1280, height: 900 });
    await signer.getByRole("checkbox").check();

    // A failed request keeps everything.
    const fail = async (route: import("@playwright/test").Route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue());
    await signer.route(`**${url}`, fail);
    await signer.getByRole("button", { name: "Review and sign…" }).click();
    await signer.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
    await expect(signer.getByRole("alert").filter({ hasText: "couldn't reach the server" })).toBeVisible();
    await signer.unroute(`**${url}`, fail);
    await expect(signer.getByLabel("Your full name")).toHaveValue("Jordan Lee");
    await expect(signer.getByRole("checkbox")).toBeChecked();
    expect(await inkOn(signer)).toBeGreaterThan(50);
    expect((await admin.from("contracts").select("status").eq("id", ev.unsigned.contractId!).single()).data!.status).toBe("sent");

    await signer.getByRole("button", { name: "Review and sign…" }).click();
    await signer.getByRole("dialog", { name: "Confirm signing" }).getByRole("button", { name: "Sign contract" }).click();
    await expect(signer.getByRole("heading", { name: "Contract signed." }).first()).toBeVisible();
    const { data: evidence } = await admin.from("contract_signatures").select("typed_name, signer_email").eq("contract_id", ev.unsigned.contractId!).single();
    expect(evidence).toMatchObject({ typed_name: "Jordan Lee", signer_email: signerEmail });

    // The signed PDF is generated after signing, then downloadable here.
    await expect.poll(async () => (await admin.from("contract_documents").select("id").eq("contract_id", ev.unsigned.contractId!)).data?.length ?? 0, { timeout: 30_000 }).toBe(1);
    await signer.reload();
    const [download] = await Promise.all([signer.waitForEvent("download"), signer.getByRole("link", { name: "Download signed PDF" }).click()]);
    expect((await readFile((await download.path())!)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("signed, awaiting deposit: outcome, payments without internal details, PDF still being prepared", async () => {
    await signer.goto(`/${a.tenant.slug}/contracts/${ev.deposit.contractId}`);
    await expect(signer.getByRole("heading", { name: "Contract signed." })).toBeVisible();
    await expect(signer.getByText(/^Signed by Jordan Lee on /)).toBeVisible();
    await expect(signer.getByRole("region", { name: "Contract overview" })).toContainText("Signed · awaiting deposit");
    await expect(signer.getByText(/Your booking will be confirmed once .* has recorded your deposit/)).toBeVisible();
    await expect(signer.getByTestId("pdf-preparing")).toBeVisible();
    const payments = signer.getByRole("region", { name: "Payments" });
    await expect(payments).toContainText("Received so far$0.00");
    await expect(payments).toContainText("Deposit still outstanding");
    await expect(signer.locator("body")).not.toContainText(/booked|pay now|planning/i);
    await shot(signer, "07-signed-awaiting-deposit");
    await signer.getByTestId("pdf-preparing").scrollIntoViewIfNeeded();
    await shot(signer, "08-pdf-preparing");
  });

  test("booked: confirmed, planning link, payments recorded without staff references", async () => {
    await signer.goto(`/${a.tenant.slug}/contracts/${ev.booked.contractId}`);
    await expect(signer.getByText("Your booking is confirmed.")).toBeVisible();
    await expect(signer.getByRole("region", { name: "Contract overview" })).toContainText("Signed · booked");
    await expect(signer.getByRole("link", { name: "Plan your event" })).toHaveAttribute("href", `/${a.tenant.slug}/planning/${ev.booked.id}`);
    const payments = signer.getByRole("region", { name: "Payments" });
    await expect(payments).toContainText("Deposit received in full");
    await expect(signer.locator("body")).not.toContainText(new RegExp(`E2E-PAYMENT-REF-SECRET|staff payment note|Staff-only note ${run}|user agent|ip address`, "i"));
    await expect(signer.getByTestId("pdf-unavailable")).toBeVisible(); // its PDF job was retired: honest wording, no staff controls
    await expect(signer.getByRole("button", { name: /retry/i })).toHaveCount(0);
    await shot(signer, "09-booked-planning-available");
  });

  test("signed out, archived and suspended: clear refusals that reveal nothing", async () => {
    const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await anon.newPage();
    await page.goto("/my");
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`/${a.tenant.slug}/contracts/${ev.booked.contractId}`);
    await expect(page.getByRole("heading", { name: "Sign in to read your contract" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(ev.booked.title);
    await anon.close();

    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", ev.booked.id));
    try {
      await signer.goto("/my");
      await expect(signer.getByRole("heading", { name: ev.deposit.title })).toBeVisible();
      await expect(signer.getByRole("heading", { name: ev.booked.title })).toHaveCount(0);
      await signer.goto(`/${a.tenant.slug}/contracts/${ev.booked.contractId}`);
      await expect(signer.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
      await expect(signer.locator("main").getByRole("link", { name: "your events" })).toBeVisible();
      await shot(signer, "10-unavailable");
    } finally {
      await must(admin.from("events").update({ archived_at: null }).eq("id", ev.booked.id));
    }

    // Suspension goes through the operator functions only (the business's own owner can't do it).
    grantPlatformAdminLocally(a.tenant.ownerEmail);
    const operator = await sessionFor(a.tenant.ownerEmail);
    const version = async () => (await must(admin.from("tenants").select("suspension_version").eq("id", b.tenant.id).single())).data!.suspension_version as number;
    await must(operator.rpc("suspend_workspace", { p_tenant_id: b.tenant.id, p_expected_version: await version(), p_reason: "E2E client home check" }));
    try {
      await signer.goto("/my");
      await expect(signer.getByRole("heading", { name: ev.booked.title })).toBeVisible();
      await expect(signer.getByRole("heading", { name: ev.soon.title })).toHaveCount(0);
      await expect(signer.locator("body")).not.toContainText(b.tenant.displayName);
      await signer.goto(`/${b.tenant.slug}/contracts/${ev.soon.contractId}`);
      await expect(signer.getByRole("heading", { name: "This contract isn't available" })).toBeVisible();
      await expect(signer.locator("body")).not.toContainText(/suspend/i);
    } finally {
      await must(operator.rpc("restore_workspace", { p_tenant_id: b.tenant.id, p_expected_version: await version(), p_reason: "E2E client home check done" }));
      revokePlatformAdminLocally(a.tenant.ownerEmail);
    }
  });
});
