import { execFileSync } from "node:child_process";
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

export async function signInStaff(page: Page, email: string) {
  const started = Date.now();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("If that email has a Flux DJ account");
  const message = await waitForEmail(email, { after: started, subject: /sign-in link/ });
  const href = /href="([^"]+\/auth\/confirm[^"]+)"/.exec(message.html)![1].replaceAll("&amp;", "&");
  await page.goto(href);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/staff/**");
}
