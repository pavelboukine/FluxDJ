import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

export const MAILPIT = "http://127.0.0.1:54324";

export const status = JSON.parse(
  execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
) as { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL)) throw new Error("E2E tests run against local Supabase only");

export const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type MailSummary = { ID: string; Created: string; Subject: string };

/** Waits for the newest email to `to` (optionally matching a subject) created after `after`. */
export async function waitForEmail(to: string, opts: { after?: number; subject?: RegExp } = {}): Promise<{ subject: string; text: string; html: string }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await res.json()) as { messages: MailSummary[] };
    const match = messages.find(
      (m) => (!opts.after || Date.parse(m.Created) >= opts.after - 1000) && (!opts.subject || opts.subject.test(m.Subject)),
    );
    if (match) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as { Subject: string; Text: string; HTML: string };
      return { subject: message.Subject, text: message.Text, html: message.HTML };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email for ${to}${opts.subject ? ` matching ${opts.subject}` : ""}`);
}

/**
 * After a "send me a link" click: the confirmation, or a clear error when the
 * app's per-IP limiter refused (instead of a bare 15-second timeout). Those
 * limits are fixed windows aligned to the clock, so the reset time is exact.
 */
export async function expectLinkRequested(page: Page, confirmation: string | RegExp, limit: { bucket: string; windowSeconds: number }) {
  const sent = page.getByText(confirmation);
  const refused = page.getByRole("alert").filter({ hasText: /Too many/ });
  await expect(sent.or(refused).first()).toBeVisible();
  if (await refused.isVisible()) {
    const resetAt = new Date((Math.floor(Date.now() / 1000 / limit.windowSeconds) + 1) * limit.windowSeconds * 1000);
    throw new Error(
      `The app's "${limit.bucket}" rate limit for 127.0.0.1 is used up (shared with your own local browser). ` +
        `It resets at ${resetAt.toLocaleTimeString()}. Feature specs do not need it; only the real login specs do.`,
    );
  }
}

/**
 * Signs `page` in with a real single-use Supabase link, through the same
 * /auth/confirm page and POST a clicked email link uses: real verification,
 * real session cookies, and every route and RLS check as usual. It only skips
 * requesting the link through a form and reading it from Mailpit, so feature
 * specs do not use up the app's per-IP sign-in limits. The forms themselves
 * are covered by staff-flow.spec.ts (staff login, unknown emails, link
 * scanners, no-JS) and contract-send-flow.spec.ts (client invitations).
 *
 * The link is created exactly as the contract verification email creates it
 * (src/lib/email/outbox.server.ts): "invite" creates or confirms a first-time
 * identity, a magic link signs in an existing one.
 */
export async function signInWithLink(page: Page, email: string, next?: string) {
  let link = await withAuthRetry(() => admin.auth.admin.generateLink({ type: "invite", email }));
  let type = "invite";
  if (link.error?.code === "email_exists") {
    type = "email";
    link = await withAuthRetry(() => admin.auth.admin.generateLink({ type: "magiclink", email }));
  }
  if (link.error) throw link.error;
  const params = new URLSearchParams({ token_hash: link.data.properties.hashed_token, type, ...(next ? { next } : {}) });
  await page.goto(`/auth/confirm?${params}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/auth/confirm");
  if (new URL(page.url()).pathname === "/login") throw new Error(`sign-in link for ${email} was rejected (${page.url()})`);
}

/** Supabase allows one link per address per second; retries that briefly instead of failing. */
async function withAuthRetry<T extends { error: { status?: number } | null }>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await call();
    if (result.error?.status !== 429 || attempt === 5) return result;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
}

/** A staff member signs in (see signInWithLink) and lands in their workspace. */
export async function signInStaff(page: Page, email: string) {
  await signInWithLink(page, email);
  await page.waitForURL("**/staff/**");
}

/**
 * The client follows their contract email and verifies their address, as the
 * "Confirm your email to read your contract" link does: they land on the
 * invitation page, signed in. The invitation request form itself (and its
 * rate limits) is covered by contract-send-flow.spec.ts.
 */
export async function verifyContractInvitation(page: Page, invitationUrl: string, signerEmail: string) {
  const url = new URL(invitationUrl);
  const slug = url.pathname.split("/")[1];
  const tokenHash = createHash("sha256").update(url.hash.slice(1)).digest("hex");
  const { data: link, error } = await admin.from("access_links").select("id").eq("token_hash", tokenHash).single();
  if (error) throw error;
  await signInWithLink(page, signerEmail, `/${slug}/invitations/${link.id}`);
  await page.waitForURL(`**/${slug}/invitations/${link.id}`);
}

/**
 * Opens a section of the client's planning page (a library key, or null for
 * the overview) the way a client does: the navigation column on wide
 * screens, the section picker on phones. Returns the section's panel.
 */
export async function openPlanSection(page: Page, key: string | null) {
  const view = key ?? "overview";
  const panel = page.locator(`#plan-panel-${view}`);
  if (await panel.isVisible()) return panel;
  const picker = page.getByTestId("section-picker");
  if (await picker.isVisible()) {
    if (!(await picker.evaluate((el) => (el as HTMLDetailsElement).open))) await picker.locator("summary").first().click();
    await picker.getByTestId(`nav-${view}`).click();
  } else {
    await page.getByRole("navigation", { name: "Planning sections" }).getByTestId(`nav-${view}`).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens a moment's card within its stage's section; returns the card. */
export async function openPlanMoment(page: Page, stageKey: string, momentKey: string) {
  const panel = await openPlanSection(page, stageKey);
  const card = panel.getByTestId(`moment-${momentKey}`);
  if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) await card.locator("summary").first().click();
  return card;
}
