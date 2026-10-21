/**
 * The contract invitation and what follows signing, in real browsers against local Supabase, in dedicated test
 * businesses with generated logos (never a real one). Contracts are sent and signed through the database functions
 * the app calls (booking.ts); signing in the browser is covered by contract-signing-flow and client-use-signing.
 *   - a valid invitation shows the business's logo (or name), its colour on the primary action and "Powered by
 *     Flux DJ", on a phone and a desktop, and nothing about the event or client before verification;
 *   - a colour without a logo and neither both work; a verified signer already signed in skips the second email;
 *   - incomplete, unknown, another business's, revoked, expired, archived-event and already-signed links stay neutral;
 *   - the invitation page after sign-in is branded once verified (signed out: neutral);
 *   - after signing: the deposit as the next step (never "booked"), then booked once the deposit is recorded,
 *     and a $0 booking booked on signing with nothing to pay; each leads to the event page.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { brandTheme } from "../../src/lib/branding/colors";
import { transparentPng } from "../support/logo-fixtures";
import { must, sendContractFor, sessionFor, signContractFor } from "./booking";
import { admin, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const tenants: TestTenant[] = [];

async function business(suite: string, branding: { primary: string | null; logo?: boolean }) {
  const tenant = await createTestTenant(suite, { catalog: true });
  tenants.push(tenant);
  await must(admin.from("tenants").update({ brand_colors: branding.primary ? { primary: branding.primary } : {} }).eq("id", tenant.id));
  if (branding.logo) {
    const png = await transparentPng(640, 160);
    const path = `${tenant.id}/logos/${randomUUID()}.png`;
    await must(admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" }));
    const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
    const { data: logoId } = await must(admin.rpc("register_tenant_logo", {
      p_tenant_id: tenant.id, p_user_id: owner!.user_id, p_storage_path: path, p_sha256: createHash("sha256").update(png).digest("hex"),
      p_byte_size: png.length, p_width: 640, p_height: 160, p_needs_dark_background: false,
    }));
    const { data: t } = await must(admin.from("tenants").select("branding_version").eq("id", tenant.id).single());
    await must((await sessionFor(tenant.ownerEmail)).rpc("update_tenant_branding", {
      p_tenant_id: tenant.id, p_expected_version: t!.branding_version, p_logo_id: logoId, p_primary_color: branding.primary,
    }));
  }
  return tenant;
}

type Sent = { tenant: TestTenant; eventId: string; email: string; title: string; contractId: string; linkId: string; token: string };
async function sent(tenant: TestTenant, opts: { discount?: { type: "percent"; percent_basis_points: number; label: string | null }; plan?: boolean } = {}): Promise<Sent> {
  const eventId = randomUUID();
  const clientId = randomUUID();
  const email = `e2e-cinv-${randomUUID().slice(0, 8)}@example.test`;
  const title = `E2E Private Event ${randomUUID().slice(0, 6)}`;
  await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Private Client Name", email }));
  await must(admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title, event_type: "corporate", event_date: "2027-10-02", venue_name: "Private Venue" }));
  await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  if (opts.plan) {
    const staffDb = await sessionFor(tenant.ownerEmail);
    await must(staffDb.rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
    const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "simple_party").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
  }
  return { tenant, eventId, email, title, ...(await sendContractFor(tenant, eventId, { discount: opts.discount })) };
}

async function openLink(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

async function expectNeutral(page: Page, message: RegExp, names: string[]) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your contract");
  await expect(page.locator("main").getByRole("alert")).toHaveText(message);
  await expect(page.getByRole("link", { name: "Flux DJ home" })).toBeVisible();
  for (const name of names) await expect(page.locator("body")).not.toContainText(name);
  await expect(page.locator("[data-plan-shell][style]")).toHaveCount(0);
}

test.describe.serial("contract invitation and after signing", () => {
  let wide: TestTenant;
  let rose: TestTenant;
  let plain: TestTenant;
  let a: Sent;
  let b: Sent;
  let c: Sent;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    [wide, rose, plain] = await Promise.all([
      business("cinv-wide", { primary: "#cbc7ff", logo: true }),
      business("cinv-rose", { primary: "#E11D48" }),
      business("cinv-plain", { primary: null }),
    ]);
    a = await sent(wide, { plan: true });
    b = await sent(rose);
    c = await sent(plain);
  });

  test.afterAll(async () => {
    for (const t of tenants) await archiveTestTenant(t);
  });

  for (const width of [390, 1440]) {
    test(`a valid invitation shows the business's logo and colour, and nothing private (${width}px)`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 } });
      const page = await context.newPage();
      await openLink(page, `/${wide.slug}/invite#${a.token}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your agreement is ready");
      await expect(page.locator("main")).toContainText(`Please review and sign your agreement with ${wide.displayName}.`);
      expect(new URL(page.url()).hash).toBe("");
      const logo = page.getByRole("img", { name: wide.displayName });
      await expect(logo).toBeVisible();
      const box = (await logo.boundingBox())!;
      expect(Math.abs(box.width / box.height - 4)).toBeLessThan(0.1);
      const button = page.getByRole("button", { name: "Email me a sign-in link" });
      await expect(button).toHaveCSS("background-color", rgb(brandTheme("#cbc7ff").ink));
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByText("Powered by Flux DJ")).toBeVisible();
      for (const secret of [a.title, "Private Client Name", "Private Venue", a.email]) await expect(page.locator("body")).not.toContainText(secret);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      for (let i = 0; i < 4 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await context.close();
    });
  }

  test("a colour without a logo, and neither", async ({ page }) => {
    await openLink(page, `/${rose.slug}/invite#${b.token}`);
    await expect(page.locator("main").getByRole("img")).toHaveCount(0);
    await expect(page.locator("main section > div").first()).toHaveText(rose.displayName);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCSS("background-color", rgb(brandTheme("#E11D48").ink));
    await openLink(page, `/${plain.slug}/invite#${c.token}`);
    await expect(page.locator("main section > div").first()).toHaveText(plain.displayName);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCSS("background-color", rgb(brandTheme(null).ink));
  });

  test("incomplete, unknown and another business's links stay neutral", async ({ page }) => {
    const names = [wide.displayName, rose.displayName];
    await openLink(page, `/${wide.slug}/invite`);
    await expectNeutral(page, /^This link is incomplete\./, names);
    await openLink(page, `/${wide.slug}/invite#${randomBytes(32).toString("base64url")}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    // A planning invitation's or a real contract's token, under another business's address.
    await openLink(page, `/${rose.slug}/invite#${a.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
  });

  test("the verified signer already signed in skips the second email; the invitation page is branded once verified", async ({ browser }) => {
    const anonymous = await browser.newContext();
    const anon = await anonymous.newPage();
    await anon.goto(`/${wide.slug}/invitations/${a.linkId}`);
    await expect(anon.getByRole("heading", { level: 1 })).toHaveText("Open your contract");
    await expect(anon.locator("body")).not.toContainText(wide.displayName);
    await anonymous.close();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signInWithLink(page, a.email, `/${wide.slug}/invitations/${a.linkId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your agreement is ready");
    await expect(page.getByRole("img", { name: wide.displayName })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open my contract" })).toHaveCSS("background-color", rgb(brandTheme("#cbc7ff").ink));
    // Opening the emailed link again while signed in: no second verification email.
    await openLink(page, `/${wide.slug}/invite#${a.token}`);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
    await page.getByRole("link", { name: "Review your contract" }).click();
    await page.waitForURL(`**/${wide.slug}/invitations/${a.linkId}`);
    await page.getByRole("button", { name: "Open my contract" }).click();
    await page.waitForURL(`**/${wide.slug}/contracts/${a.contractId}`);
    await expect(page.getByRole("link", { name: "Go to signing" })).toBeVisible();
    await context.close();
  });

  test("after signing with the deposit outstanding: signed, never booked; then booked once the deposit is recorded", async ({ browser }) => {
    await signContractFor(wide, a.eventId, a.email, a.contractId, a.linkId, { recordDeposit: false });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signInWithLink(page, a.email, `/${wide.slug}/contracts/${a.contractId}`);
    const outcome = page.getByTestId("signed-outcome");
    await expect(outcome).toHaveAttribute("data-state", "awaiting_deposit");
    await expect(outcome.getByRole("heading", { level: 2 })).toHaveText("Your contract is signed!");
    await expect(outcome).toContainText("The next step is your deposit to finalize the booking.");
    const { data: k } = await must(admin.from("contracts").select("deposit_cents").eq("id", a.contractId).single());
    const deposit = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(k!.deposit_cents / 100);
    await expect(outcome).toContainText(`Deposit to pay: ${deposit}`);
    await expect(outcome).toContainText("Flux DJ doesn't take payments");
    await expect(page.locator("body")).not.toContainText(/officially booked|pay now/i);
    await expect(outcome.getByRole("link", { name: "Deposit details" })).toHaveAttribute("href", "#payments");
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // The signed invitation link is used up: neutral, naming nothing.
    await openLink(page, `/${wide.slug}/invite#${a.token}`);
    await expectNeutral(page, /already been signed/, [wide.displayName]);

    // Staff record the deposit: the database books the event, and the page says so.
    const { data: paid } = await must((await sessionFor(wide.ownerEmail)).rpc("record_event_payment", {
      p_event_id: a.eventId, p_amount_cents: k!.deposit_cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      p_reference: null, p_note: null, p_idempotency_key: randomUUID(), p_confirm_duplicate: false,
    }));
    expect((paid as { booking: string }).booking).toBe("booked");
    await page.goto(`/${wide.slug}/contracts/${a.contractId}`);
    await expect(outcome).toHaveAttribute("data-state", "booked");
    await expect(outcome.getByRole("heading", { level: 2 })).toHaveText("Your event is officially booked!");
    await expect(outcome).toContainText("You can now start organizing your music, timing and special moments");
    await outcome.getByRole("link", { name: "Go to your event" }).click();
    await page.waitForURL(`**/${wide.slug}/events/${a.eventId}`);
    await expect(page.getByTestId("event-status")).toHaveText("Booked");
    await context.close();
  });

  test("a $0 booking is booked on signing: nothing to pay, the DJ in touch about what comes next, straight to the event", async ({ page }) => {
    const free = await sent(plain, { discount: { type: "percent", percent_basis_points: 10000, label: "Complimentary" } });
    await signContractFor(plain, free.eventId, free.email, free.contractId, free.linkId, { recordDeposit: false });
    expect((await must(admin.from("events").select("lifecycle_status").eq("id", free.eventId).single())).data!.lifecycle_status).toBe("booked");
    expect((await admin.from("payments").select("id").eq("event_id", free.eventId)).data ?? []).toHaveLength(0);
    await signInWithLink(page, free.email, `/${plain.slug}/contracts/${free.contractId}`);
    const outcome = page.getByTestId("signed-outcome");
    await expect(outcome).toHaveAttribute("data-state", "booked");
    await expect(outcome).toContainText(`${plain.displayName} will be in touch about what comes next.`);
    await expect(outcome).not.toContainText(/deposit/i);
    await expect(page.locator("#payments")).toContainText("No payment due");
    await expect(page.locator("#payments")).not.toContainText(/still outstanding|Remaining balance/);
    await outcome.getByRole("link", { name: "Go to your event" }).click();
    await page.waitForURL(`**/${plain.slug}/events/${free.eventId}`);
  });

  test("revoked, expired and archived-event invitations stay neutral", async ({ page }) => {
    const names = [rose.displayName, plain.displayName];
    // Revoked.
    await must(admin.from("access_links").update({ revoked_at: new Date().toISOString() }).eq("id", b.linkId));
    await openLink(page, `/${rose.slug}/invite#${b.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    // Expired: a link recorded as already expired (expiry can't change on a sent link).
    const { data: link } = await must(admin.from("access_links").select("tenant_id, proposal_id, intended_client_id, contract_id").eq("id", b.linkId).single());
    const expired = randomBytes(32).toString("base64url");
    await must(admin.from("access_links").insert({
      ...link!, id: randomUUID(), purpose: "contract", token_hash: createHash("sha256").update(expired).digest("hex"),
      created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    }));
    await openLink(page, `/${rose.slug}/invite#${expired}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    // Archived event.
    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", c.eventId));
    await openLink(page, `/${plain.slug}/invite#${c.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
  });
});
