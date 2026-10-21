/**
 * The planning invitation page carries the inviting business's own branding, in a real browser
 * against local Supabase, in dedicated test businesses with generated logos (never a real one):
 *   - a valid link shows the business's logo (contained, never stretched) or its name, its
 *     colour on the primary action (Brand Ink) and "Powered by Flux DJ", on a phone and a
 *     desktop, and nothing about the event or client before verification;
 *   - a logo without a colour, a colour without a logo, and neither all work;
 *   - incomplete, unknown, revoked, expired, archived-event and another business's links keep
 *     the neutral Flux page with a generic message naming no business;
 *   - the invitation page after sign-in is branded only once it is verified (signed out: neutral);
 *   - an invitation for a Flux booking is branded the same way; keyboard focus is visible.
 * The sign-in request, verification and acceptance are covered by flux-planning-invitation and
 * external-booking-flow; this spec checks presentation and what each link reveals.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { brandTheme } from "../../src/lib/branding/colors";
import { transparentPng } from "../support/logo-fixtures";
import { bookEvent, must, sessionFor } from "./booking";
import { admin, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

type Invite = { tenant: TestTenant; eventId: string; clientEmail: string; title: string; token: string; invitationId: string };
const tenants: TestTenant[] = [];

async function business(suite: string, branding: { primary?: string | null; logo?: [number, number] }) {
  const tenant = await createTestTenant(suite, { catalog: true });
  tenants.push(tenant);
  await must(admin.from("tenants").update({ brand_colors: branding.primary ? { primary: branding.primary } : {} }).eq("id", tenant.id));
  if (branding.logo) {
    const png = await transparentPng(...branding.logo);
    const path = `${tenant.id}/logos/${randomUUID()}.png`;
    await must(admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" }));
    const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
    const { data: logoId } = await must(admin.rpc("register_tenant_logo", {
      p_tenant_id: tenant.id, p_user_id: owner!.user_id, p_storage_path: path, p_sha256: createHash("sha256").update(png).digest("hex"),
      p_byte_size: png.length, p_width: branding.logo[0], p_height: branding.logo[1], p_needs_dark_background: false,
    }));
    const { data: t } = await must(admin.from("tenants").select("branding_version").eq("id", tenant.id).single());
    await must((await sessionFor(tenant.ownerEmail)).rpc("update_tenant_branding", {
      p_tenant_id: tenant.id, p_expected_version: t!.branding_version, p_logo_id: logoId, p_primary_color: branding.primary ?? null,
    }));
  }
  await must((await sessionFor(tenant.ownerEmail)).rpc("install_starter_planning_templates", { p_tenant_id: tenant.id }));
  return tenant;
}

async function invite(tenant: TestTenant, opts: { flux?: boolean } = {}): Promise<Invite> {
  const eventId = randomUUID();
  const clientId = randomUUID();
  const clientEmail = `e2e-invbrand-${randomUUID().slice(0, 8)}@example.test`;
  const title = `E2E Private Event ${randomUUID().slice(0, 6)}`;
  await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Private Client Name", email: clientEmail }));
  await must(admin.from("events").insert({
    id: eventId, tenant_id: tenant.id, title, event_type: "corporate", event_date: "2027-10-02", venue_name: "Private Venue",
    ...(opts.flux ? {} : { booking_source: "external" }),
  }));
  await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
  const staffDb = await sessionFor(tenant.ownerEmail);
  const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "simple_party").single());
  await must(staffDb.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
  if (opts.flux) await bookEvent(tenant, eventId, clientEmail);
  return { tenant, eventId, clientEmail, title, ...(await sendInvitation(tenant, eventId)) };
}

async function sendInvitation(tenant: TestTenant, eventId: string) {
  const token = randomBytes(32).toString("base64url");
  const invitationId = randomUUID();
  await must((await sessionFor(tenant.ownerEmail)).rpc("send_planning_invitation", {
    p_event_id: eventId, p_invitation_id: invitationId, p_token_hash: createHash("sha256").update(token).digest("hex"),
  }));
  return { token, invitationId };
}

/** Opens an invitation link as a fresh page load (a hash-only change would not reload it). */
async function openLink(page: Page, path: string) {
  await page.goto("about:blank");
  await page.goto(path);
}

/** The neutral page: Flux frame, a generic message, and no business named. */
async function expectNeutral(page: Page, message: RegExp, names: string[]) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your event planning");
  await expect(page.locator("main").getByRole("alert")).toHaveText(message);
  await expect(page.getByRole("link", { name: "Flux DJ home" })).toBeVisible();
  for (const name of names) await expect(page.locator("body")).not.toContainText(name);
  await expect(page.locator("[data-plan-shell][style]")).toHaveCount(0);
}

test.describe.serial("planning invitation branding", () => {
  let wide: TestTenant; // logo + pale colour
  let rose: TestTenant; // colour, no logo
  let square: TestTenant; // logo, no colour
  let plain: TestTenant; // neither
  let a: Invite;
  let b: Invite;
  let c: Invite;
  let d: Invite;

  test.beforeAll(async () => {
    wide = await business("invbrand-wide", { primary: "#cbc7ff", logo: [640, 160] });
    rose = await business("invbrand-rose", { primary: "#E11D48" });
    square = await business("invbrand-square", { primary: null, logo: [300, 300] });
    plain = await business("invbrand-plain", { primary: null });
    [a, b, c, d] = await Promise.all([invite(wide), invite(rose), invite(square), invite(plain)]);
  });

  test.afterAll(async () => {
    for (const t of tenants) await archiveTestTenant(t);
  });

  for (const width of [390, 1440]) {
    test(`a valid link shows the business's logo, colour and name, and nothing private (${width}px)`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 } });
      const page = await context.newPage();
      await openLink(page, `/${wide.slug}/planning-invite#${a.token}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're invited to plan your event");
      expect(new URL(page.url()).hash).toBe("");
      const logo = page.getByRole("img", { name: wide.displayName });
      await expect(logo).toBeVisible();
      // Contained, never stretched: the box keeps the 4:1 artwork's shape within its limits.
      const box = (await logo.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(56);
      expect(box.width).toBeLessThanOrEqual(224);
      expect(Math.abs(box.width / box.height - 4)).toBeLessThan(0.1);
      await expect(page.locator("main")).toContainText(`the address ${wide.displayName} has on file`);
      const button = page.getByRole("button", { name: "Email me a sign-in link" });
      await expect(button).toHaveCSS("background-color", rgb(brandTheme("#cbc7ff").ink));
      await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByText("Powered by Flux DJ")).toBeVisible();
      for (const secret of [a.title, "Private Client Name", "Private Venue", a.clientEmail]) await expect(page.locator("body")).not.toContainText(secret);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      // Keyboard: the primary action is reachable and its focus visible.
      // (dev mode adds its own tools button to the page, so allow a few stops before it).
      for (let i = 0; i < 4 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect(button).not.toHaveCSS("box-shadow", "none");
      await context.close();
    });
  }

  test("a colour without a logo, a logo without a colour, and neither", async ({ page }) => {
    await openLink(page, `/${rose.slug}/planning-invite#${b.token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're invited to plan your event");
    await expect(page.locator("main").getByRole("img")).toHaveCount(0);
    await expect(page.locator("main section > div").first()).toHaveText(rose.displayName);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCSS("background-color", rgb(brandTheme("#E11D48").ink));

    await openLink(page, `/${square.slug}/planning-invite#${c.token}`);
    const logo = page.getByRole("img", { name: square.displayName });
    await expect(logo).toBeVisible();
    const box = (await logo.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCSS("background-color", rgb(brandTheme(null).ink));

    await openLink(page, `/${plain.slug}/planning-invite#${d.token}`);
    await expect(page.locator("main section > div").first()).toHaveText(plain.displayName);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCSS("background-color", rgb(brandTheme(null).ink));
  });

  test("incomplete, unknown and another business's links stay neutral and name no business", async ({ page }) => {
    const names = [wide.displayName, rose.displayName];
    await openLink(page, `/${wide.slug}/planning-invite`);
    await expectNeutral(page, /^This link is incomplete\./, names);
    await openLink(page, `/${wide.slug}/planning-invite#${randomBytes(32).toString("base64url")}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    await openLink(page, `/${wide.slug}/planning-invite#not-a-token`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    // A real invitation of one business opened under another's address.
    await openLink(page, `/${rose.slug}/planning-invite#${a.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("revoked, expired and archived-event invitations stay neutral", async ({ page }) => {
    const names = [rose.displayName, square.displayName, plain.displayName];
    // A newer invitation replaces (revokes) the earlier one.
    const newer = await sendInvitation(rose, b.eventId);
    await openLink(page, `/${rose.slug}/planning-invite#${b.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
    await openLink(page, `/${rose.slug}/planning-invite#${newer.token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're invited to plan your event");

    // Expiry can't be changed on a sent invitation, so an already-expired one is recorded for its own event.
    const { data: rows } = await must(admin.from("planning_invitations").select("tenant_id, event_id, client_id, email, invited_by").eq("id", d.invitationId).single());
    await must(admin.from("planning_invitations").update({ revoked_at: new Date().toISOString(), revoke_reason: "e2e: replaced by an expired copy" }).eq("id", d.invitationId));
    const expiredToken = randomBytes(32).toString("base64url");
    await must(admin.from("planning_invitations").insert({
      ...rows!, id: randomUUID(), token_hash: createHash("sha256").update(expiredToken).digest("hex"),
      created_at: new Date(Date.now() - 15 * 86_400_000).toISOString(), expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    }));
    await openLink(page, `/${plain.slug}/planning-invite#${expiredToken}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);

    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", c.eventId));
    await openLink(page, `/${square.slug}/planning-invite#${c.token}`);
    await expectNeutral(page, /^This invitation isn't available any more\./, names);
  });

  test("the invitation page after sign-in: neutral when signed out, branded once verified, then planning", async ({ browser }) => {
    const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const anon = await anonymous.newPage();
    await anon.goto(`/${wide.slug}/planning-invitations/${a.invitationId}`);
    await expect(anon.getByRole("heading", { level: 1 })).toHaveText("Open your event planning");
    await expect(anon.locator("body")).not.toContainText(wide.displayName);
    await expect(anon.locator("[data-plan-shell][style]")).toHaveCount(0);
    // The "Confirm your email" step on the way here says where it continues (its look is the shared sign-in page's).
    await anon.goto(`/auth/confirm?${new URLSearchParams({ token_hash: "a".repeat(56), type: "email", next: `/${wide.slug}/planning-invitations/${a.invitationId}` })}`);
    await expect(anon.getByRole("heading", { level: 1 })).toHaveText("Open your event planning");
    await expect(anon.locator("main")).toContainText("continue to your event planning");
    await anonymous.close();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const client = await context.newPage();
    await signInWithLink(client, a.clientEmail, `/${wide.slug}/planning-invitations/${a.invitationId}`);
    await client.waitForURL(`**/${wide.slug}/planning-invitations/${a.invitationId}`);
    await expect(client.getByRole("heading", { level: 1 })).toHaveText("Your planning is ready");
    await expect(client.getByRole("img", { name: wide.displayName })).toBeVisible();
    await expect(client.getByText("Let's plan the details.")).toBeVisible();
    const open = client.getByRole("button", { name: "Open my planning" });
    await expect(open).toHaveCSS("background-color", rgb(brandTheme("#cbc7ff").ink));
    expect(await sideways(client)).toBeLessThanOrEqual(0);
    await open.click();
    await client.waitForURL(`**/${wide.slug}/planning/${a.eventId}`);
    await expect(client.getByRole("heading", { level: 1, name: a.title })).toBeVisible();
    await context.close();
  });

  test("a Flux booking's invitation is branded the same way", async ({ page }) => {
    const flux = await invite(rose, { flux: true });
    await openLink(page, `/${rose.slug}/planning-invite#${flux.token}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're invited to plan your event");
    await expect(page.locator("main")).toContainText(rose.displayName);
    await expect(page.locator("body")).not.toContainText(flux.title);
  });
});
