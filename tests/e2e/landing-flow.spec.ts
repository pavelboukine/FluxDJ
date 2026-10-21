/**
 * The public front door and sign-in wording, in a dedicated test business:
 * the homepage's two ways in (DJ, client), the role-worded sign-in page and
 * the destination it carries (allow-listed only), a sign-in link continuing
 * to the page that asked for it, and what signed-in DJs, clients and people
 * who are both see on the homepage. Signs in with the fast helper only (the
 * sign-in form and its per-IP limits belong to staff-flow).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { admin, signInWithLink, status } from "./support";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const MAILPIT = "http://127.0.0.1:54324";
const APP = "http://127.0.0.1:3000";

/** The newest sign-in link emailed to `email` after `after`. */
async function emailedLink(email: string, after: number): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { messages } = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: { ID: string; Created: string }[] };
    const fresh = messages.find((m) => Date.parse(m.Created) >= after - 1000);
    if (fresh) {
      const { HTML } = (await (await fetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)).json()) as { HTML: string };
      const href = /href="([^"]+\/auth\/confirm[^"]+)"/.exec(HTML)?.[1];
      if (href) return href.replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no sign-in email for ${email}`);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Gives `email` verified client access to a new event of the test business (no booking needed to list it). */
async function grantEvent(email: string): Promise<string> {
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = users.users.find((u) => u.email === email)!;
  const eventId = randomUUID();
  const clientId = randomUUID();
  await admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Landing Client", email });
  await admin.from("events").insert({ id: eventId, tenant_id: tenant.id, title: `Landing event ${run}`, event_type: "wedding", event_date: "2027-08-14" });
  await admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true });
  await admin.from("event_access").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, user_id: user.id });
  return eventId;
}

test.describe("public homepage and sign-in", () => {
  test.beforeAll(async () => {
    tenant = await createTestTenant("landing");
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("signed out: what Flux DJ is and one clear way in for DJs and for clients, on a phone and by keyboard", async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: { width: 320, height: 640 } })).newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every great event starts with a plan.");
    const audiences = page.getByTestId("audiences");
    await expect(audiences.getByRole("heading", { level: 2 })).toHaveText(["I'm a DJ", "I'm a client"]);
    await expect(page.getByRole("link", { name: "DJ sign in" })).toHaveAttribute("href", "/login?role=dj");
    await expect(page.getByRole("link", { name: "Client sign in" })).toHaveAttribute("href", "/login?role=client");
    await expect(page.getByText("Flux DJ is invite-only for now.")).toBeVisible();
    await expect(page.getByText(/staff sign in/i)).toHaveCount(0);
    await expect(page.getByTestId("signed-in")).toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // Keyboard: the wordmark, then the DJ and client entry points, in reading order.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Flux DJ home" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "DJ sign in" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Client sign in" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/login?role=client");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to your event portal");
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  test("the sign-in page is worded for DJs or clients and carries only an allowed destination", async ({ page }) => {
    await page.goto("/login?role=dj");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to Flux DJ");
    await expect(page.getByText("DJ accounts are by invitation for now.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();

    const planning = `/${tenant.slug}/planning/${randomUUID()}`;
    await page.goto(`/login?role=client&next=${encodeURIComponent(planning)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to your event portal");
    await expect(page.getByTestId("login-next")).toBeVisible();
    await expect(page.locator('input[name="next"]')).toHaveValue(planning);
    await expect(page.locator('input[name="role"]')).toHaveValue("client");
    // Switching to the DJ wording keeps the destination.
    await expect(page.getByRole("link", { name: "DJ sign in" })).toHaveAttribute("href", `/login?role=dj&next=${encodeURIComponent(planning)}`);

    // Anything else is dropped: other sites, encoded tricks, unknown roles.
    for (const next of ["https://evil.example/staff", "//evil.example", "/%2F%2Fevil.example", "/my?x=https://evil.example"]) {
      await page.goto(`/login?role=admin&next=${encodeURIComponent(next)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to Flux DJ");
      await expect(page.getByTestId("login-next")).toHaveCount(0);
      await expect(page.locator('input[name="next"]')).toHaveCount(0);
      await expect(page.locator('input[name="role"]')).toHaveCount(0);
    }
  });

  test("a sign-in link continues to the page that asked for it; an unsafe remembered destination is ignored", async ({ browser }) => {
    const email = `e2e-landing-client-${run}@example.test`;
    const contract = `/${tenant.slug}/contracts/${randomUUID()}`;
    // What the sign-in form remembers on this browser when the client asks for a link from that page.
    const context = await browser.newContext();
    await context.addCookies([{ name: "flux_sign_in_next", value: contract, domain: "127.0.0.1", path: "/auth/confirm", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await signInWithLink(page, email);
    await expect(page).toHaveURL(contract);
    // Used once: it's cleared after signing in.
    expect((await context.cookies("http://127.0.0.1:3000/auth/confirm")).find((c) => c.name === "flux_sign_in_next")).toBeUndefined();
    await context.close();

    const tampered = await browser.newContext();
    await tampered.addCookies([{ name: "flux_sign_in_next", value: "https://evil.example/my", domain: "127.0.0.1", path: "/auth/confirm", httpOnly: true, sameSite: "Lax" }]);
    const other = await tampered.newPage();
    await signInWithLink(other, email);
    // The default: /staff, which sends a client (no staff role) to their events.
    await expect(other).toHaveURL("/my");
    await tampered.close();
  });

  test("signed in: clients, DJs and people who are both see where they can go, and nothing redirects on its own", async ({ browser }) => {
    // A client (no events yet): their events page is offered; the DJ entry still says sign in.
    const clientEmail = `e2e-landing-only-client-${run}@example.test`;
    const client = await (await browser.newContext()).newPage();
    await signInWithLink(client, clientEmail);
    await client.goto("/");
    await expect(client).toHaveURL("/");
    await expect(client.getByTestId("signed-in")).toContainText(`Signed in as ${clientEmail}`);
    await expect(client.getByTestId("signed-in").getByRole("link")).toHaveText(["Your events"]);
    await expect(client.getByRole("link", { name: "DJ sign in" })).toBeVisible();
    await client.context().close();

    // The DJ: the dashboard.
    const dj = await (await browser.newContext()).newPage();
    await signInWithLink(dj, tenant.ownerEmail);
    await dj.goto("/");
    await expect(dj).toHaveURL("/");
    await expect(dj.getByTestId("signed-in").getByRole("link")).toHaveText(["DJ dashboard"]);
    await expect(dj.getByRole("link", { name: "Open your dashboard" })).toHaveAttribute("href", "/staff");
    await expect(dj.getByRole("link", { name: "Client sign in" })).toBeVisible();

    // The same person as a client of an event: both areas.
    await grantEvent(tenant.ownerEmail);
    await dj.reload();
    await expect(dj.getByTestId("signed-in").getByRole("link")).toHaveText(["DJ dashboard", "Your events"]);
    await expect(dj.getByRole("link", { name: "Open your events" })).toHaveAttribute("href", "/my");
    await dj.getByTestId("signed-in").getByRole("link", { name: "Your events" }).click();
    await dj.waitForURL("**/my");
    await expect(dj.getByRole("heading", { name: `Landing event ${run}` })).toBeVisible();
    await dj.context().close();
  });

  test("a client's contract and planning pages send them to the client sign-in, coming back afterwards", async ({ page }) => {
    const contract = `/${tenant.slug}/contracts/${randomUUID()}`;
    await page.goto(contract);
    await expect(page.getByRole("link", { name: "Sign in with your email" })).toHaveAttribute("href", `/login?role=client&next=${encodeURIComponent(contract)}`);
    const planning = `/${tenant.slug}/planning/${randomUUID()}`;
    await page.goto(planning);
    await expect(page.getByRole("link", { name: "Sign in with your email" })).toHaveAttribute("href", `/login?role=client&next=${encodeURIComponent(planning)}`);
  });

  test("the emailed link carries its destination: opened in another browser (no remembered cookie), it still continues there", async ({ browser }) => {
    const email = `e2e-landing-xbrowser-${run}@example.test`;
    await admin.auth.admin.createUser({ email, email_confirm: true });
    const planning = `/${tenant.slug}/planning/${randomUUID()}`;
    // What the client sign-in form asks Supabase for (the form itself belongs to staff-flow's per-IP budget).
    const started = Date.now();
    const anon = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } });
    const { error } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${APP}/auth/confirm?next=${encodeURIComponent(planning)}` } });
    expect(error).toBeNull();
    const link = await emailedLink(email, started);
    expect(new URL(link).searchParams.get("redirect_to")).toBe(`${APP}/auth/confirm?next=${encodeURIComponent(planning)}`);

    // A different browser (the mail app's), with nothing remembered.
    const other = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await other.newPage();
    await page.goto(link);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your event planning");
    await expect(page.getByRole("link", { name: "Flux DJ home" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(planning);
    await other.close();
  });

  test("a link's own destination (an invitation) wins over the one the email carried", async ({ page }) => {
    const email = `e2e-landing-invite-${run}@example.test`;
    const link = await admin.auth.admin.generateLink({ type: "invite", email });
    const contract = `/${tenant.slug}/contracts/${randomUUID()}`;
    const params = new URLSearchParams({
      token_hash: link.data.properties!.hashed_token,
      type: "invite",
      next: contract,
      redirect_to: `${APP}/auth/confirm?next=%2Fmy`,
    });
    await page.goto(`/auth/confirm?${params}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your contract");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(contract);
  });

  test("the confirm page: matching style, signed-in note, incomplete and expired links, on a phone in landscape too", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
    const page = await context.newPage();
    await page.goto("/auth/confirm");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link is incomplete");
    await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    // An expired or wrong link: back to sign-in, with the error and the destination kept for the next request.
    const planning = `/${tenant.slug}/planning/${randomUUID()}`;
    await page.goto(`/auth/confirm?${new URLSearchParams({ token_hash: "a".repeat(56), type: "email", next: planning })}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your event planning");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`**/login?role=client&next=${encodeURIComponent(planning)}&error=link`);
    await expect(page.locator("main").getByRole("alert")).toHaveText("That sign-in link is invalid or has expired. Request a new one.");
    await expect(page.locator('input[name="next"]')).toHaveValue(planning);

    // Already signed in as someone else: said before anything changes.
    await signInWithLink(page, tenant.ownerEmail);
    const other = await admin.auth.admin.generateLink({ type: "invite", email: `e2e-landing-second-${run}@example.test` });
    await page.goto(`/auth/confirm?${new URLSearchParams({ token_hash: other.data.properties!.hashed_token, type: "invite" })}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back to Flux DJ");
    await expect(page.getByTestId("confirm-signed-in")).toContainText(`This browser is signed in as ${tenant.ownerEmail}`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await context.close();
  });
});
