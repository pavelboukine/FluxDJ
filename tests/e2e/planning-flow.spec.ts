/**
 * Planning in a real browser against local Supabase, in a dedicated test
 * tenant. The booking itself (proposal, approval, contract, signature,
 * deposit) is set up through the same database functions the app calls
 * (their screens are covered by the proposal, contract and payment specs);
 * everything about planning goes through the UI:
 *   - booking without a chosen template gives a Basics-only plan and staff
 *     are prompted to configure it;
 *   - starter templates are added explicitly and idempotently; templates are
 *     renamed, reordered, trimmed and duplicated with stable keys;
 *   - the client (phone-sized) opens planning from /my, sees imported answers
 *     read-only and fills Event basics with autosave: edits typed during a
 *     save survive, a failed save keeps input and retries, a stale tab gets a
 *     conflict;
 *   - staff apply a template without losing answers, hide and restore a stage,
 *     and template edits don't reach the plan;
 *   - archiving closes client planning; unarchiving reopens it.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin, signInStaff, status, waitForEmail } from "./support";
import { archiveTestTenant, createTestTenant, publishContractTemplate, submitAsClient, type TestTenant } from "./tenant";

let tenant: TestTenant;
const run = randomUUID().slice(0, 6);
const clientEmail = `e2e-plan-${run}@example.test`;
const title = `E2E Plan Wedding ${run}`;
// A 1x1 PNG: the signing function checks the stored object's type and size.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

/** A real Auth session for an existing user, from a magic-link token (no email, no rate limit). */
async function sessionFor(email: string): Promise<SupabaseClient> {
  const { data } = await must(admin.auth.admin.generateLink({ type: "magiclink", email }));
  const db = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await must(db.auth.verifyOtp({ token_hash: data.properties!.hashed_token, type: "magiclink" }));
  return db;
}

/** Proposal sent, submitted, approved; contract generated, sent, accepted and signed by the client; deposit recorded. */
async function bookEvent(eventId: string): Promise<string> {
  const staffDb = await sessionFor(tenant.ownerEmail);
  const { data: template } = await must(admin.from("proposal_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding (DEMO)").single());
  const { data: input } = await must(staffDb.rpc("proposal_offer_input_from_template", { p_template_id: template!.id }));
  const { data: proposalId } = await must(staffDb.rpc("open_proposal_draft", { p_event_id: eventId, p_offer: input }));
  const { data: draft } = await must(admin.from("proposals").select("draft_version").eq("id", proposalId).single());
  await must(staffDb.rpc("send_proposal", { p_proposal_id: proposalId, p_expected_draft_version: draft!.draft_version, p_access_link_id: randomUUID(), p_token_hash: randomUUID().replaceAll("-", "").repeat(2) }));
  await submitAsClient(tenant, proposalId as string);
  const { data: selection } = await must(admin.from("proposal_selections").select("id").eq("proposal_id", proposalId).not("submitted_at", "is", null).single());
  const { data: approval } = await must(staffDb.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: selection!.id }));
  const versionId = await publishContractTemplate(tenant, "Agreement (DEMO)", "DEMO, NOT FOR CLIENT USE: Agreement for {{event.title}}", [
    { heading: "Payment", body: "Total {{pricing.total}}. Deposit ({{payment.deposit_percent}}): {{payment.deposit}}." },
  ]);
  const { data: generated } = await must(staffDb.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staffDb.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: createHash("sha256").update(randomUUID()).digest("hex") }));

  const { data: user } = await must(admin.auth.admin.createUser({ email: clientEmail, email_confirm: true }));
  const clientDb = await sessionFor(clientEmail);
  await must(clientDb.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: tenant.slug }));
  const { data: c } = await must(admin.from("contracts").select("content_sha256, consent_version, deposit_cents").eq("id", contractId).single());
  const path = `${tenant.id}/${contractId}/${randomUUID()}.png`;
  await must(admin.storage.from("contract-signatures").upload(path, PNG, { contentType: "image/png" }));
  const { data: signed } = await must(admin.rpc("sign_contract", {
    p_contract_id: contractId, p_tenant_slug: tenant.slug, p_user_id: user.user!.id, p_typed_name: "Jordan Lee",
    p_content_sha256: c!.content_sha256, p_consent_version: c!.consent_version, p_consent_accepted: true, p_signature_path: path,
    p_signature_sha256: createHash("sha256").update(PNG).digest("hex"), p_signature_bytes: PNG.length, p_signature_width: 1, p_signature_height: 1,
    p_user_agent: "E2E", p_client_ip: null, p_client_ip_source: "unavailable",
  }));
  expect((signed as { status: string }).status).toBe("signed");
  // No PDF needed here; retire the job so later signing specs never wait behind it.
  const { data: jobs } = await must(admin.rpc("claim_document_jobs", { p_limit: 5, p_lease_seconds: 30, p_contract_id: contractId }));
  for (const j of (jobs ?? []) as { job_id: string; lease_token: string }[]) {
    await admin.rpc("fail_document_job", { p_job_id: j.job_id, p_lease_token: j.lease_token, p_error: "planning e2e: PDF not needed", p_permanent: true });
  }
  const { data: paid } = await must(staffDb.rpc("record_event_payment", {
    p_event_id: eventId, p_amount_cents: c!.deposit_cents, p_paid_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    p_reference: "E2E-PAYMENT-REF-SECRET", p_note: "E2E staff payment note", p_idempotency_key: randomUUID(), p_confirm_duplicate: false,
  }));
  expect((paid as { booking: string }).booking).toBe("booked");
  return contractId;
}

async function signInClient(page: Page, email: string) {
  const started = Date.now();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("If that email has a Flux DJ account");
  const message = await waitForEmail(email, { after: started, subject: /sign-in link/ });
  await page.goto(/href="([^"]+\/auth\/confirm[^"]+)"/.exec(message.html)![1].replaceAll("&amp;", "&"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/my");
}

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const basicsRow = async (eventId: string) => {
  const { data } = await admin.from("event_plans").select("id, event_plan_items(id, key)").eq("event_id", eventId).single();
  const item = data!.event_plan_items.find((i) => i.key === "basics")!;
  return (await admin.from("event_plan_responses").select("answers, revision, updated_by_actor").eq("item_id", item.id).maybeSingle()).data;
};

test.describe.serial("planning", () => {
  let browser: Browser;
  let staffContext: BrowserContext;
  let staff: Page;
  let clientContext: BrowserContext;
  let client: Page;
  let eventId = "";
  let contractId = "";
  let planningUrl = "";
  let staffPlanningUrl = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    tenant = await createTestTenant("plan", { catalog: true });
    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: tenant.id, name: "Jordan Lee", email: clientEmail }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: tenant.id, title, event_type: "wedding", event_date: "2027-08-14",
      venue_name: "Château E2E", venue_address: "1 Rue du Lac, Gatineau", internal_notes: "E2E INTERNAL NOTE never for clients",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: tenant.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    // Sign in first: Auth refuses a sign-in email within a second of the setup's own magic-link token for the same address.
    staffContext = await browser.newContext();
    staff = await staffContext.newPage();
    await signInStaff(staff, tenant.ownerEmail);
    contractId = await bookEvent(eventId);
    planningUrl = `/${tenant.slug}/planning/${eventId}`;
    staffPlanningUrl = `/staff/${tenant.slug}/events/${eventId}/planning`;
  });

  test.afterAll(async () => {
    await archiveTestTenant(tenant);
  });

  test("booking without a template creates Event basics only, and staff are prompted to configure it", async () => {
    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    const card = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Planning", { exact: true }) });
    await expect(card).toContainText("Event basics only: choose a template to add the event's stages.");
    await card.getByRole("link", { name: "Open planning" }).click();
    await staff.waitForURL(`**${staffPlanningUrl}`);
    await expect(staff.getByText("Created with Event basics only, because no template was chosen. Set up when the event was booked.")).toBeVisible();
    await expect(staff.getByText("Choose a template below to add this event's stages and moments")).toBeVisible();
    await expect(staff.getByTestId("client-access")).toContainText("The event is booked: the client");
    // Frozen proposal answers, separate from planning fields.
    const frozen = staff.locator("[data-slot=card]").filter({ has: staff.getByText("From the signed contract (frozen)") });
    await expect(frozen).toContainText("DEMO: Where will the ceremony take place?");
    await expect(frozen).toContainText("Same room as the reception");
    await expect(staff.getByRole("link", { name: "Manage planning templates" })).toBeVisible();
  });

  test("starter templates are added explicitly and once; staff rename, reorder, trim and duplicate with stable keys", async () => {
    await staff.goto(`/staff/${tenant.slug}/planning-templates`);
    await expect(staff.getByText("No planning templates yet.")).toBeVisible();
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    await expect(staff.getByText("Added Wedding and Simple Party.")).toBeVisible();
    await staff.getByRole("button", { name: "Add starter templates" }).click();
    await expect(staff.getByText("The starter templates are already here")).toBeVisible();
    expect((await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id)).data).toHaveLength(2);

    await staff.getByRole("link", { name: "Wedding", exact: true }).click();
    await staff.waitForURL(/planning-templates\/[0-9a-f-]{36}$/);
    const templateId = staff.url().split("/").pop()!;
    const stageKeys = async () =>
      ((await admin.from("planning_template_items").select("key, position").eq("template_id", templateId).eq("kind", "stage").order("position")).data ?? []).map((r) => r.key);

    await staff.getByLabel("Label for Party", { exact: true }).fill("Dance party");
    await staff.getByRole("button", { name: "Rename Party", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Dance party", exact: true })).toBeVisible();
    const { data: party } = await admin.from("planning_template_items").select("key, label").eq("template_id", templateId).eq("label", "Dance party").single();
    expect(party!.key).toBe("party");

    await expect(staff.getByRole("button", { name: "Move Ceremony up", exact: true })).toBeDisabled();
    await staff.getByRole("button", { name: "Move Cocktail up", exact: true }).click();
    await expect.poll(stageKeys).toEqual(["cocktail", "ceremony", "reception_entrance", "dinner", "special_dances", "party", "closing"]);
    await staff.getByRole("button", { name: "Move Cocktail down", exact: true }).click();
    await expect.poll(stageKeys).toEqual(["ceremony", "cocktail", "reception_entrance", "dinner", "special_dances", "party", "closing"]);

    staff.once("dialog", (d) => void d.accept());
    await staff.getByRole("button", { name: "Remove Dedications", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Remove Dedications", exact: true })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Remove Event basics", exact: true })).toHaveCount(0);

    // A stale tab gets a conflict instead of overwriting.
    const stale = await staffContext.newPage();
    await stale.goto(staff.url());
    await staff.getByLabel("Label for Closing", { exact: true }).fill("Last dance");
    await staff.getByRole("button", { name: "Rename Closing", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Last dance", exact: true })).toBeVisible();
    await stale.getByLabel("Label for Cocktail", { exact: true }).fill("Cocktail hour");
    await stale.getByRole("button", { name: "Rename Cocktail", exact: true }).click();
    await expect(stale.locator("main").getByRole("alert")).toContainText("Someone else saved changes first");
    await expect(stale.getByLabel("Label for Cocktail", { exact: true })).toHaveValue("Cocktail hour");
    await stale.close();

    await staff.getByLabel("Name of the copy").fill("Wedding (French)");
    await staff.getByRole("button", { name: "Duplicate" }).click();
    await staff.waitForURL((url) => !url.pathname.endsWith(templateId));
    await expect(staff.getByRole("heading", { name: "Wedding (French)" })).toBeVisible();
    await expect(staff.getByRole("button", { name: "Rename Dance party", exact: true })).toBeVisible();
  });

  test("the client opens planning from /my on a phone, sees imported answers read-only and fills Event basics", async () => {
    clientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    client = await clientContext.newPage();
    await signInClient(client, clientEmail);
    await client.getByRole("link", { name: `Plan ${title}` }).click();
    await client.waitForURL(`**${planningUrl}`);
    await expect(client.getByRole("heading", { name: `Planning: ${title}` })).toBeVisible();
    await expect(client.getByTestId("progress-headline")).toHaveText("1 of 5 required answers");
    await expect(client.getByText("Progress covers the 1 section you can fill in now (Event basics).")).toBeVisible();
    await expect(client.getByText("Château E2E, 1 Rue du Lac, Gatineau")).toBeVisible();
    await expect(client.getByText(`Provided by ${tenant.displayName}. Contact them if it changes.`)).toBeVisible();
    const provided = client.getByRole("region", { name: "Already provided" });
    await expect(provided).toContainText("DEMO: Will there be speeches that need a wireless microphone?");
    await expect(provided).toContainText("No");
    await expect(client.getByText("No stages yet.")).toBeVisible();

    await client.getByLabel("Guest count (needed)").fill("150");
    await client.getByLabel("Start time (needed)").fill("18:00");
    await client.getByLabel("End time (needed)").fill("01:00");
    await expect(client.getByText("Ends after midnight, the next day.")).toBeVisible();
    await client.getByLabel("No special instructions").check();
    await expect(client.getByText("All changes saved")).toBeVisible();
    await expect(client.getByTestId("progress-headline")).toHaveText("Available sections done");
    await expect(client.getByText("Event basics is complete.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toEqual({ guest_count: 150, start_time: "18:00", end_time: "01:00", access_notes_none: true });

    await client.reload();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("150");
    await expect(client.getByLabel("No special instructions")).toBeChecked();
    await expect(client.locator("body")).not.toContainText(/E2E INTERNAL NOTE|E2E-PAYMENT-REF-SECRET|E2E staff payment note|Planning complete/);
    expect(await noSideways(client)).toBeLessThanOrEqual(0);

    // Invalid input stays on screen and is never sent.
    await client.getByLabel("Guest count (needed)").fill("lots");
    await expect(client.getByText("Enter a guest count between 1 and 5,000.")).toBeVisible();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("lots");
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 150 });
    await client.getByLabel("Guest count (needed)").fill("150");
    await expect(client.getByText("All changes saved")).toBeVisible();
  });

  test("edits typed while a save is pending survive; a failed save keeps input and retries; a stale tab gets a conflict", async () => {
    let release: () => void = () => {};
    let held = false;
    await client.route(`**${planningUrl}`, async (route) => {
      if (!held && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        held = true;
        await new Promise<void>((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await client.getByLabel("Guest count (needed)").fill("160");
    await expect(client.getByText("Saving…")).toBeVisible();
    await client.getByLabel("Room or space within the venue (optional)").fill("Grand hall");
    release();
    await expect(client.getByText("All changes saved")).toBeVisible();
    await expect.poll(async () => (await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 160, venue_room: "Grand hall" });
    await client.unroute(`**${planningUrl}`);

    await client.route(`**${planningUrl}`, (route) =>
      route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await client.getByLabel("Guest count (needed)").fill("170");
    await expect(client.locator("main").getByRole("alert")).toContainText("Couldn't save. Check your connection and retry. Your answers are still here.");
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("170");
    await client.unroute(`**${planningUrl}`);
    await client.getByRole("button", { name: "Retry saving" }).click();
    await expect(client.getByText("All changes saved")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 170 });

    const other = await clientContext.newPage();
    await other.goto(planningUrl);
    await client.getByLabel("Guest count (needed)").fill("175");
    await expect(client.getByText("All changes saved")).toBeVisible();
    await other.getByLabel("Room or space within the venue (optional)").fill("Terrace");
    await expect(other.locator("main").getByRole("alert")).toContainText("changed in another tab or window");
    await expect(other.getByLabel("Room or space within the venue (optional)")).toHaveValue("Terrace");
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175, venue_room: "Grand hall" });
    await other.close();
  });

  test("staff apply a template without losing answers; the client sees the stages in order", async () => {
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByText("Last saved by the client.")).toBeVisible();
    await expect(staff.getByLabel("Guest count (needed)")).toHaveValue("175");
    const apply = staff.locator("[data-slot=card]").filter({ has: staff.getByText("Replace the structure with a template") });
    await apply.getByLabel("Template").selectOption({ label: "Wedding" });
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByRole("alert")).toContainText("Check the box to confirm replacing the structure.");
    await apply.getByLabel(/I understand this replaces/).check();
    await apply.getByRole("button", { name: "Apply template" }).click();
    await expect(apply.getByText("Template applied: 1 kept, 37 added, 0 hidden. No answers were removed.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175, venue_room: "Grand hall" });

    await client.reload();
    const stages = client.getByRole("list", { name: "Stages of the event, in order" }).locator(":scope > li summary");
    await expect(stages).toHaveText([
      /1\. Ceremony/, /2\. Cocktail/, /3\. Reception entrance/, /4\. Dinner/, /5\. Special dances/, /6\. Dance party/, /7\. Last dance/,
    ]);
    const ceremony = client.getByTestId("stage-ceremony");
    await expect(ceremony).toContainText("Not available yet");
    await ceremony.locator("summary").click();
    await expect(ceremony).toContainText("Processional participants");
    await expect(client.getByTestId("section-contacts_vendors")).toContainText("Not available yet");
    await expect(client.getByTestId("progress-headline")).toHaveText("Available sections done");
    await expect(client.getByText(/The other sections open later and aren't counted yet/)).toBeVisible();
    expect(await noSideways(client)).toBeLessThanOrEqual(0);
  });

  test("hiding a stage hides it from the client and keeps its moments; restoring brings them back in order", async () => {
    await staff.goto(staffPlanningUrl);
    await staff.getByRole("button", { name: "Hide Dinner from the client", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Restore Dinner", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("stage-dinner")).toHaveCount(0);
    await expect(client.locator("body")).not.toContainText("Cake cutting");

    await staff.getByRole("button", { name: "Restore Dinner", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Hide Dinner from the client", exact: true })).toBeVisible();
    await client.reload();
    const dinner = client.getByTestId("stage-dinner");
    await dinner.locator("summary").click();
    await expect(dinner.locator("li")).toHaveText([/Timing/, /Background music/, /Speeches and toasts/, /Activities/, /Cake cutting/]);

    // Template edits don't reach this event's plan.
    const { data: template } = await admin.from("planning_templates").select("id").eq("tenant_id", tenant.id).eq("name", "Wedding").single();
    await staff.goto(`/staff/${tenant.slug}/planning-templates/${template!.id}`);
    await staff.getByLabel("Label for Ceremony", { exact: true }).fill("Vows");
    await staff.getByRole("button", { name: "Rename Ceremony", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Rename Vows", exact: true })).toBeVisible();
    await client.reload();
    await expect(client.getByTestId("stage-ceremony").locator("summary")).toContainText("Ceremony");

    // The staff planning page fits a phone too.
    const phone = await staffContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(staffPlanningUrl);
    await expect(phone.getByRole("heading", { name: `Planning: ${title}` })).toBeVisible();
    expect(await noSideways(phone)).toBeLessThanOrEqual(0);
    await phone.close();
  });

  test("the contract page links to planning; archiving closes client planning and unarchiving reopens it", async () => {
    await client.goto(`/${tenant.slug}/contracts/${contractId}`);
    await client.getByRole("link", { name: "Plan your event" }).click();
    await client.waitForURL(`**${planningUrl}`);

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByRole("button", { name: "Archive…" }).click();
    await staff.getByRole("dialog", { name: "Confirm archiving" }).getByRole("button", { name: "Archive event" }).click();
    await expect(staff.getByRole("button", { name: "Unarchive event" })).toBeVisible();
    await client.getByLabel("Guest count (needed)").fill("180");
    await expect(client.locator("main").getByRole("alert")).toContainText("Planning isn't available for this event any more.");
    await client.reload();
    await expect(client.getByRole("heading", { name: "Planning isn't available" })).toBeVisible();
    await staff.goto(staffPlanningUrl);
    await expect(staff.getByText("Unarchive the event to edit planning.")).toBeVisible();
    expect((await basicsRow(eventId))!.answers).toMatchObject({ guest_count: 175 });

    await staff.goto(`/staff/${tenant.slug}/events/${eventId}`);
    await staff.getByRole("button", { name: "Unarchive event" }).click();
    await expect(staff.getByRole("button", { name: "Archive…" })).toBeVisible();
    await client.reload();
    await expect(client.getByLabel("Guest count (needed)")).toHaveValue("175");
    await clientContext.close();
  });
});
