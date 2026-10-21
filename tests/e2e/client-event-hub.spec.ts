/**
 * A client's event hub (/{slug}/events/{eventId}) in real browsers against local Supabase, in dedicated test
 * businesses (bookings through the database functions the app calls, see booking.ts):
 *   - /my links each event to its hub; the hub carries its own business's branding;
 *   - booked (with a discount): planning leads, the approved proposal, signed contract and payments are there,
 *     and the approved proposal shows the frozen selection and discount, whatever the catalogue does later;
 *   - signed but awaiting the deposit: never called booked; the contract's "Go to your event" leads here;
 *   - a $0 booking says "No payment due"; planning not set up says the DJ is getting it ready;
 *   - booked elsewhere: planning only, no proposal, contract or payments;
 *   - someone at the event who isn't the signer: status and planning, never the financial documents;
 *   - archived, another business's address or someone else's event: one neutral answer naming nothing;
 *   - signed out: back here through sign-in; back links lead to the event, then to all events.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { brandTheme } from "../../src/lib/branding/colors";
import { transparentPng } from "../support/logo-fixtures";
import { bookEvent, must, sessionFor } from "./booking";
import { admin, signInWithLink } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-hub-${run}@example.test`;
const partnerEmail = `e2e-hub-partner-${run}@example.test`;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const hub = (t: TestTenant, eventId: string) => `/${t.slug}/events/${eventId}`;

async function addLogo(tenant: TestTenant) {
  const png = await transparentPng(480, 160);
  const path = `${tenant.id}/logos/${randomUUID()}.png`;
  await must(admin.storage.from("tenant-logos").upload(path, png, { contentType: "image/png" }));
  const { data: owner } = await must(admin.from("tenant_memberships").select("user_id").eq("tenant_id", tenant.id).eq("role", "owner").single());
  const { data: logoId } = await must(admin.rpc("register_tenant_logo", {
    p_tenant_id: tenant.id, p_user_id: owner!.user_id, p_storage_path: path, p_sha256: createHash("sha256").update(png).digest("hex"),
    p_byte_size: png.length, p_width: 480, p_height: 160, p_needs_dark_background: false,
  }));
  const { data: t } = await must(admin.from("tenants").select("branding_version").eq("id", tenant.id).single());
  await must((await sessionFor(tenant.ownerEmail)).rpc("update_tenant_branding", {
    p_tenant_id: tenant.id, p_expected_version: t!.branding_version, p_logo_id: logoId, p_primary_color: "#cbc7ff",
  }));
}

async function event(tenant: TestTenant, clientId: string, title: string, opts: { external?: boolean; plan?: boolean } = {}) {
  const id = randomUUID();
  await must(admin.from("events").insert({
    id, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-09-18", venue_name: "Salle Hub",
    ...(opts.external ? { booking_source: "external" } : {}),
  }));
  await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: id, client_id: clientId, is_primary: true, can_sign: true }));
  if (opts.plan !== false) {
    const staffDb = await sessionFor(tenant.ownerEmail);
    const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("starter_key", "simple_party").single());
    await must(staffDb.rpc("setup_event_plan", { p_event_id: id, p_template_id: template!.id }));
  }
  return id;
}

test.describe.serial("client event hub", () => {
  let lumiere: TestTenant;
  let rose: TestTenant;
  const ids = { booked: "", deposit: "", free: "", archived: "", external: "" };
  const titles = { booked: `Hub Booked ${run}`, deposit: `Hub Deposit ${run}`, free: `Hub Free ${run}`, archived: `Hub Archived ${run}`, external: `Hub Elsewhere ${run}` };
  let bookedContract = "";
  let depositContract = "";

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    lumiere = await createTestTenant("hub-lumiere", { catalog: true });
    rose = await createTestTenant("hub-rose", { catalog: true });
    await addLogo(lumiere);
    await must(admin.from("tenants").update({ brand_colors: { primary: "#E11D48" } }).eq("id", rose.id));
    for (const t of [lumiere, rose]) await must((await sessionFor(t.ownerEmail)).rpc("install_starter_planning_templates", { p_tenant_id: t.id }));

    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: lumiere.id, name: "Jordan Lee", email: clientEmail }));
    ids.booked = await event(lumiere, clientId, titles.booked);
    bookedContract = await bookEvent(lumiere, ids.booked, clientEmail, { discount: { type: "percent", percent_basis_points: 1000, label: "Early booking" } });
    ids.deposit = await event(lumiere, clientId, titles.deposit);
    depositContract = await bookEvent(lumiere, ids.deposit, clientEmail, { recordDeposit: false });
    ids.free = await event(lumiere, clientId, titles.free, { plan: false });
    await bookEvent(lumiere, ids.free, clientEmail, { discount: { type: "percent", percent_basis_points: 10000, label: "Complimentary" }, recordDeposit: false });
    ids.archived = await event(lumiere, clientId, titles.archived);
    await bookEvent(lumiere, ids.archived, clientEmail);
    await must(admin.from("events").update({ archived_at: new Date().toISOString() }).eq("id", ids.archived));

    // The same person's event with another business, booked elsewhere, through a planning invitation.
    const roseClient = randomUUID();
    await must(admin.from("clients").insert({ id: roseClient, tenant_id: rose.id, name: "Jordan Lee", email: clientEmail }));
    ids.external = await event(rose, roseClient, titles.external, { external: true });
    const invitationId = randomUUID();
    await must((await sessionFor(rose.ownerEmail)).rpc("send_planning_invitation", {
      p_event_id: ids.external, p_invitation_id: invitationId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex"),
    }));
    await must((await sessionFor(clientEmail)).rpc("accept_planning_invitation", { p_invitation_id: invitationId, p_tenant_slug: rose.slug }));

    // Someone else at the booked event, with access but not the signer.
    const partnerId = randomUUID();
    await must(admin.from("clients").insert({ id: partnerId, tenant_id: lumiere.id, name: "Sam Partner", email: partnerEmail }));
    await must(admin.from("event_clients").insert({ tenant_id: lumiere.id, event_id: ids.booked, client_id: partnerId, is_primary: false, can_sign: false }));
    const { data: partner } = await must(admin.auth.admin.createUser({ email: partnerEmail, email_confirm: true }));
    await must(admin.from("event_access").insert({ tenant_id: lumiere.id, event_id: ids.booked, client_id: partnerId, user_id: partner.user!.id }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(lumiere);
    await archiveTestTenant(rose);
  });

  test("/my links each event to its hub; each hub carries its own business's branding", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInWithLink(page, clientEmail);
    await page.goto("/my");
    for (const title of [titles.booked, titles.deposit, titles.free, titles.external]) await expect(page.getByTestId("event-hub-link").filter({ hasText: title })).toBeVisible();
    await expect(page.getByText(titles.archived)).toHaveCount(0);
    await page.getByTestId("event-hub-link").filter({ hasText: titles.external }).click();
    await page.waitForURL(`**${hub(rose, ids.external)}`);
    await expect(page.locator("main")).toContainText(rose.displayName);
    // Read the resting colour: the pointer that clicked on /my may be over the button now.
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("hub-primary")).toHaveCSS("background-color", rgb(brandTheme("#E11D48").ink));
    await page.goto("/my");
    await page.getByTestId("event-hub-link").filter({ hasText: titles.booked }).click();
    await page.waitForURL(`**${hub(lumiere, ids.booked)}`);
    await expect(page.getByRole("img", { name: lumiere.displayName })).toBeVisible();
    // Read the resting colour: the pointer that clicked on /my may be over the button now.
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("hub-primary")).toHaveCSS("background-color", rgb(brandTheme("#cbc7ff").ink));
  });

  for (const width of [390, 1440]) {
    test(`booked: planning leads; proposal, signed contract and payments; back links (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
      await signInWithLink(page, clientEmail, hub(lumiere, ids.booked));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(titles.booked);
      await expect(page.getByTestId("event-status")).toHaveText("Booked");
      // One full-width next step with a planning summary, not a copy of the planning overview.
      const next = page.getByTestId("hub-next-step");
      await expect(next.getByRole("heading", { level: 2 })).toHaveText("Plan your event");
      await expect(next.getByTestId("hub-progress")).toContainText("required answers");
      await expect(next.getByTestId("hub-deadline")).toContainText("You can make changes through");
      await expect(page.getByTestId("hub-planning")).toHaveCount(0);
      await expect(page.getByTestId("hub-primary")).toHaveCount(1);
      const booking = page.getByTestId("hub-booking");
      await expect(booking.getByRole("link", { name: /Approved proposal/ })).toHaveAttribute("href", `${hub(lumiere, ids.booked)}/proposal`);
      await expect(booking.getByRole("link", { name: /Signed contract/ })).toHaveAttribute("href", `/${lumiere.slug}/contracts/${bookedContract}`);
      // The signed PDF downloads from the contract page, not the hub.
      await expect(page.getByRole("link", { name: "Download signed PDF" })).toHaveCount(0);
      const payments = page.locator("#payments");
      await expect(payments).toContainText("Received so far");
      await expect(payments).toContainText("Early booking");
      expect(await sideways(page)).toBeLessThanOrEqual(0);

      // Open planning lands on the planning overview, never a section; the overview's own Continue planning goes on.
      await expect(page.getByTestId("hub-primary")).toHaveText("Open planning");
      await expect(page.getByTestId("hub-primary")).toHaveAttribute("href", `/${lumiere.slug}/planning/${ids.booked}`);
      // The footer credit: "Powered by" and the Flux wordmark (named for screen readers).
      await expect(page.getByTestId("client-footer")).toContainText("Powered by");
      await expect(page.getByTestId("client-footer").getByRole("img", { name: "Flux DJ" })).toBeVisible();
      await page.getByTestId("hub-primary").click();
      await page.waitForURL(new RegExp(`/${lumiere.slug}/planning/${ids.booked}$`));
      await expect(page.locator("#plan-panel-overview")).toBeVisible();
      await expect(page.getByTestId("client-page-title")).toHaveText("Your planning");
      await expect(page.getByTestId("client-footer")).toHaveCount(1);
      await expect(page.getByTestId("footer-flux-logo")).toHaveCount(1);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      await page.getByTestId("plan-primary").filter({ hasText: "Continue planning" }).click();
      await page.waitForURL(new RegExp(`/${lumiere.slug}/planning/${ids.booked}\\?section=[a-z0-9_]+$`));
      const section = new URL(page.url()).searchParams.get("section")!;
      await expect(page.locator(`#plan-panel-${section}`)).toBeVisible();
      await expect(page.locator("#plan-panel-overview")).toBeHidden();
      await page.getByRole("link", { name: "Your event", exact: true }).click();
      await page.waitForURL(`**${hub(lumiere, ids.booked)}`);
      await booking.getByRole("link", { name: /Signed contract/ }).click();
      await page.waitForURL(`**/contracts/${bookedContract}`);
      await page.getByRole("link", { name: "Your event", exact: true }).click();
      await page.waitForURL(`**${hub(lumiere, ids.booked)}`);
      await page.getByRole("link", { name: "Your events", exact: true }).click();
      await page.waitForURL("**/my");
    });
  }

  test("the approved proposal: the frozen selection and discount, unchanged by later catalogue prices", async ({ page }) => {
    await signInWithLink(page, clientEmail, `${hub(lumiere, ids.booked)}/proposal`);
    const proposal = page.getByTestId("approved-proposal");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your approved proposal");
    await expect(proposal).toContainText("Signature");
    await expect(proposal.getByTestId("price-discount")).toContainText("Early booking");
    const { data: c } = await must(admin.from("contracts").select("total_cents").eq("id", bookedContract).single());
    const totalText = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(c!.total_cents / 100);
    await expect(proposal).toContainText(totalText);
    // The business reprices its catalogue: the agreed proposal doesn't move.
    await must(admin.from("packages").update({ base_price_cents: 999_900 }).eq("tenant_id", lumiere.id));
    await page.reload();
    await expect(proposal).toContainText(totalText);
    await expect(proposal).not.toContainText("9,999.00");
    await page.getByRole("link", { name: "Your event", exact: true }).click();
    await page.waitForURL(`**${hub(lumiere, ids.booked)}`);
  });

  test("signed, deposit outstanding: never booked; the contract leads to the event", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInWithLink(page, clientEmail, `/${lumiere.slug}/contracts/${depositContract}`);
    await expect(page.getByText("Your booking will be confirmed once")).toBeVisible();
    await page.getByTestId("go-to-event").click();
    await page.waitForURL(`**${hub(lumiere, ids.deposit)}`);
    await expect(page.getByTestId("event-status")).toHaveText("Signed · awaiting deposit");
    const next = page.getByTestId("hub-next-step");
    await expect(next.getByRole("heading", { level: 2 })).toHaveText("Pay your deposit");
    await expect(next).toContainText("Your booking is confirmed once they record it");
    await expect(page.getByText("Your booking is confirmed.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("hub-planning")).toHaveCount(0);
    await next.getByRole("link", { name: "See payment details" }).click();
    await expect(page.locator("#payments")).toContainText("Deposit still outstanding");
  });

  test("a $0 booking says no payment is due; planning not set up says it's coming", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInWithLink(page, clientEmail, hub(lumiere, ids.free));
    await expect(page.getByTestId("event-status")).toHaveText("Booked");
    await expect(page.locator("#payments")).toContainText("No payment due");
    await expect(page.locator("#payments")).not.toContainText("Deposit on signing");
    await expect(page.getByTestId("hub-next-step").getByRole("heading", { level: 2 })).toHaveText("Your DJ is getting planning ready");
    await expect(page.getByTestId("hub-primary")).toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("booked elsewhere: planning only, nothing to sign or pay", async ({ page }) => {
    await signInWithLink(page, clientEmail, hub(rose, ids.external));
    await expect(page.getByTestId("event-status")).toHaveText("Booked");
    await expect(page.getByTestId("hub-next-step").getByTestId("hub-primary")).toHaveText("Open planning");
    await expect(page.getByTestId("hub-primary")).toHaveAttribute("href", `/${rose.slug}/planning/${ids.external}`);
    await expect(page.getByTestId("hub-booking")).toHaveCount(0);
    await expect(page.locator("#payments")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/contract|deposit|proposal/i);
  });

  test("someone at the event who isn't the signer: status and planning, never the financial documents", async ({ page }) => {
    await signInWithLink(page, partnerEmail, hub(lumiere, ids.booked));
    await expect(page.getByTestId("event-status")).toHaveText("Booked");
    await expect(page.getByTestId("hub-next-step").getByTestId("hub-primary")).toHaveText("Open planning");
    await expect(page.getByTestId("hub-booking")).toHaveCount(0);
    await expect(page.locator("#payments")).toHaveCount(0);
    await page.goto(`${hub(lumiere, ids.booked)}/proposal`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This proposal isn't available");
    await expect(page.locator("body")).not.toContainText("Early booking");
    await page.goto(`/${lumiere.slug}/contracts/${bookedContract}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This contract isn't available");
    // Another event of the same business isn't theirs.
    await page.goto(hub(lumiere, ids.deposit));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This event isn't available");
    await expect(page.locator("body")).not.toContainText(titles.deposit);
  });

  test("archived, another business's address or an unknown event: one neutral answer naming nothing", async ({ page }) => {
    await signInWithLink(page, clientEmail);
    for (const path of [hub(lumiere, ids.archived), hub(rose, ids.booked), hub(lumiere, randomUUID())]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This event isn't available");
      for (const secret of [titles.archived, titles.booked, lumiere.displayName, rose.displayName]) await expect(page.locator("body")).not.toContainText(secret);
    }
    await page.goto(`${hub(rose, ids.booked)}/proposal`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This proposal isn't available");
  });

  test("signed out: sign in, then straight back to the event", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(hub(lumiere, ids.booked));
    await page.waitForURL("**/login?**");
    const url = new URL(page.url());
    expect(url.searchParams.get("role")).toBe("client");
    expect(url.searchParams.get("next")).toBe(hub(lumiere, ids.booked));
    await expect(page.getByTestId("login-next")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(titles.booked);
    await signInWithLink(page, clientEmail, hub(lumiere, ids.booked));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(titles.booked);
    await context.close();
  });
});
