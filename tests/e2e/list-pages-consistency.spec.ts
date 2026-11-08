/**
 * The eight staff list pages behave alike, in dedicated test businesses:
 * compact phone filters that keep their state in the URL and stay visible when
 * in use, whole-row links with keyboard access and independent links kept
 * apart, one primary action, and distinct states for an empty business, no
 * results and hidden archived records. Filter rules: list-pages-flow.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { admin, signInStaff } from "./support";
import { must, sessionFor } from "./booking";
import { archiveTestTenant, createTestTenant, type TestTenant } from "./tenant";
import { bookLocally } from "../support/local-sql";

const HEIGHTS: Record<number, number> = { 320: 700, 390: 844, 430: 932, 768: 1024 };
const phone = (width: number) => ({ viewport: { width, height: HEIGHTS[width] }, isMobile: true, hasTouch: true });
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const DAY = 86_400_000;
const dateIn = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * DAY));
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const LISTS = [
  { path: "events", row: "event-row", action: "Create event", empty: "events-empty", none: "events-no-results", emptyText: "No events yet." },
  { path: "clients", row: "client-row", action: "Add client", empty: "clients-empty", none: "clients-no-results", emptyText: "No clients yet." },
  { path: "gear", row: "gear-row", action: "Add gear", empty: "gear-empty", none: "gear-no-results", emptyText: "No gear yet." },
  { path: "packages", row: "package-row", action: "Create package", empty: "packages-empty", none: "packages-no-results", emptyText: "No packages yet." },
  { path: "templates", row: "template-row", action: "Create template", empty: "templates-empty", none: "templates-no-results", emptyText: "No proposal templates yet." },
  { path: "contract-templates", row: "contract-template-row", action: "Create template", empty: "contract-templates-empty", none: "contract-templates-no-results", emptyText: "No contract templates yet." },
  { path: "planning-templates", row: "planning-template-row", action: "Create template", empty: "planning-templates-empty", none: "planning-templates-no-results", emptyText: "No planning templates yet." },
  { path: "questions", row: "question-row", action: "Add question", empty: "questions-empty", none: "questions-no-results", emptyText: "No questions yet." },
] as const;

/** What a tap at this viewport point lands on: the nearest link or button's text or href. */
const linkAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("a,button")?.getAttribute("href") ?? null, [x, y]);

test.describe.serial("staff list pages", () => {
  let browser: Browser;
  let busy: TestTenant;
  let empty: TestTenant;
  let archivedOnly: TestTenant;
  let clientId: string;
  let eventId: string;
  const run = randomUUID().slice(0, 6);

  const open = async (options: object, email = busy.ownerEmail) => {
    const page = await (await browser.newContext(options)).newPage();
    await signInStaff(page, email);
    return page;
  };
  const filtersButton = (page: Page) => page.getByRole("button", { name: /^Filters/ });

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    busy = await createTestTenant("list-consistency", { catalog: true });
    empty = await createTestTenant("list-consistency-empty");
    archivedOnly = await createTestTenant("list-consistency-archived");

    clientId = randomUUID();
    eventId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: busy.id, name: "Elena Rossi", email: `elena-${run}@example.test`, phone: "514 555 0142" }));
    await must(admin.from("events").insert({ id: eventId, tenant_id: busy.id, title: "Rossi wedding", event_type: "wedding", event_date: dateIn(10), timezone: "America/Toronto", venue_name: "Le Windsor" }));
    await must(admin.from("event_clients").insert({ tenant_id: busy.id, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    bookLocally(eventId);
    await must(admin.from("events").insert({ tenant_id: busy.id, title: "Tran corporate gala", event_type: "corporate", event_date: dateIn(20), timezone: "America/Toronto" }));
    await must(admin.from("clients").insert({ tenant_id: busy.id, name: "Zoe Next", email: `zoe-${run}@example.test` }));
    await must(admin.from("contract_templates").insert({ tenant_id: busy.id, name: "Wedding DJ agreement" }));
    await must((await sessionFor(busy.ownerEmail)).rpc("install_starter_planning_templates", { p_tenant_id: busy.id }));

    await must(admin.from("gear_items").insert({ tenant_id: archivedOnly.id, key: "old_speaker", name: "Old speaker", unit_label: "speaker", default_price_cents: 1000, active: false }));
  });

  test.afterAll(async () => {
    await archiveTestTenant(busy);
    await archiveTestTenant(empty);
    await archiveTestTenant(archivedOnly);
  });

  test("on a phone, search and Filters come first and the first result sits high; from 768px the controls are inline", async () => {
    for (const width of [320, 390, 430]) {
      const page = await open(phone(width));
      for (const list of LISTS) {
        await page.goto(`/staff/${busy.slug}/${list.path}`);
        const search = page.getByRole("searchbox");
        await expect(search).toHaveCSS("font-size", "16px");
        await expect(search).toHaveCSS("height", "44px");
        await expect(filtersButton(page)).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("search").getByLabel("Include archived")).toBeHidden();
        const first = (await page.getByTestId(list.row).first().boundingBox())!;
        expect(first.y, `${list.path} at ${width}`).toBeLessThan(HEIGHTS[width] * 0.5);
        expect(await sideways(page), `${list.path} at ${width}`).toBeLessThanOrEqual(0);
      }
      await page.context().close();
    }
    for (const [options, label] of [[phone(768), "768"], [DESKTOP, "1440"]] as const) {
      const page = await open(options);
      for (const list of LISTS) {
        await page.goto(`/staff/${busy.slug}/${list.path}`);
        await expect(filtersButton(page), label).toBeHidden();
        await expect(page.getByRole("search").getByLabel("Include archived"), label).toBeVisible();
        await expect(page.getByRole("search").getByRole("button", { name: "Search" }), label).toBeVisible();
        expect(await sideways(page), `${list.path} at ${label}`).toBeLessThanOrEqual(0);
      }
      await page.context().close();
    }
  });

  test("phone filters: open and close, apply in the URL, stay named and countable, survive reload and Back, and clear", async () => {
    const page = await open(phone(390));
    const base = `/staff/${busy.slug}/events`;
    await page.goto(base);
    const button = filtersButton(page);
    const status = page.getByLabel("Status");

    await expect(status).toBeHidden();
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(status).toBeVisible();
    await button.click();
    await expect(status).toBeHidden();

    await button.click();
    await status.selectOption("booked");
    await page.waitForURL(/status=booked/);
    await expect(page.getByTestId("event-row")).toHaveCount(1);
    await expect(page.getByTestId("active-filters")).toContainText("Status: Booked");
    await expect(page.getByTestId("active-filter-count")).toContainText("1");
    await expect(status).toBeVisible(); // stays open for another change

    // Search keeps the filter, using the search field alone.
    const search = page.getByRole("searchbox");
    await search.fill("rossi");
    await search.press("Enter");
    await page.waitForURL(/q=rossi/);
    expect(page.url()).toContain("status=booked");

    await page.reload();
    await expect(status).toBeHidden(); // folded again, but still named
    await expect(page.getByTestId("active-filters")).toContainText("Status: Booked");
    await expect(search).toHaveValue("rossi");
    await button.click();
    await expect(status).toHaveValue("booked");

    await page.getByTestId("active-filters").getByRole("link", { name: "Clear filters" }).click();
    await page.waitForURL((url) => url.pathname === base && url.search === "");
    await expect(page.getByTestId("active-filters")).toHaveCount(0);
    await expect(page.getByTestId("event-row")).toHaveCount(2);
    await expect(search).toHaveValue("");

    await page.goBack();
    await page.waitForURL(/status=booked/);
    await expect(page.getByTestId("active-filters")).toContainText("Status: Booked");
    await expect(search).toHaveValue("rossi");
    await page.goForward();
    await page.waitForURL((url) => url.search === "");
    await expect(page.getByTestId("event-row")).toHaveCount(2);

    // Include archived counts as a filter too.
    await page.goto(`/staff/${busy.slug}/gear?archived=1`);
    await expect(page.getByTestId("active-filters")).toContainText("Including archived");
    await page.context().close();
  });

  test("the whole row is one link, with keyboard access and a pending line", async () => {
    const page = await open(DESKTOP);
    for (const list of LISTS) {
      await page.goto(`/staff/${busy.slug}/${list.path}`);
      const row = page.getByTestId(list.row).first();
      await expect(row.locator("a a")).toHaveCount(0);
      const link = row.getByRole("link").first();
      const href = (await link.getAttribute("href"))!;
      expect(href).toContain(`/staff/${busy.slug}/${list.path}/`);

      // The far end of the row, away from the title.
      const box = (await row.boundingBox())!;
      await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
      await page.waitForURL(`**${href}`);
      await page.goBack();
      await page.waitForURL(`**/staff/${busy.slug}/${list.path}`);

      // Keyboard: focus shows on the row, Enter follows the link.
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(link).toBeFocused();
      await expect(row).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Enter");
      await page.waitForURL(`**${href}`);
    }

    // Navigation feedback: a slow row navigation shows the header's progress line.
    await page.goto(`/staff/${busy.slug}/gear`);
    const row = page.getByTestId("gear-row").first();
    const href = (await row.getByRole("link").getAttribute("href"))!;
    await page.route((url) => url.pathname === href, async (route) => {
      const headers = route.request().headers();
      if (headers["rsc"] && !headers["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    });
    await row.getByRole("link").click();
    await expect(page.getByTestId("navigation-progress")).toHaveCSS("opacity", "1");
    await page.waitForURL(`**${href}`);
    await page.context().close();
  });

  test("independent parts of a row stay independent, and tap areas stay in their own rows", async () => {
    for (const [options, label] of [[DESKTOP, "desktop"], [phone(390), "phone"]] as const) {
      const page = await open(options);
      const list = `/staff/${busy.slug}/clients`;
      await page.goto(list);
      const row = page.getByTestId("client-row").filter({ hasText: "Elena Rossi" });

      // The next-event link leads to the event, not the client.
      await row.getByTestId("next-event").click();
      await page.waitForURL(`**/events/${eventId}`);
      await page.goBack();
      await page.waitForURL(`**${list}`);

      // Desktop: contact details can be selected, so pressing them navigates nowhere.
      if (label === "desktop") {
        const contact = (await row.getByTestId("client-contact").boundingBox())!;
        await page.mouse.click(contact.x + 4, contact.y + contact.height / 2);
        await page.waitForTimeout(300);
        expect(new URL(page.url()).pathname).toBe(list);
      }

      // The rest of the row leads to the client.
      const box = (await row.boundingBox())!;
      await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
      await page.waitForURL(`**/clients/${clientId}`);
      await page.context().close();
    }

    const page = await open(phone(390));
    await page.goto(`/staff/${busy.slug}/clients`);
    const rows = page.getByTestId("client-row");
    // Phones have no dead band: a tap on the contact line opens the client too.
    const contact = rows.filter({ hasText: "Elena Rossi" }).getByTestId("client-contact");
    const contactBox = (await contact.boundingBox())!;
    expect(await linkAt(page, contactBox.x + 4, contactBox.y + contactBox.height / 2)).toContain(`/clients/${clientId}`);
    const [elena, zoe] = [rows.filter({ hasText: "Elena Rossi" }), rows.filter({ hasText: "Zoe Next" })];
    await elena.scrollIntoViewIfNeeded();
    const boundary = (await elena.boundingBox())!;
    const clientHref = (r: string | null) => r?.split("/").at(-1);

    // A date link's tap area ends inside its row: just below belongs to the next row.
    const date = (await elena.getByTestId("next-event").boundingBox())!;
    expect(date.y + date.height).toBeLessThanOrEqual(boundary.y + boundary.height + 0.5);
    const below = await linkAt(page, boundary.x + 40, boundary.y + boundary.height + 2);
    expect(clientHref(below)).toBe(clientHref(await zoe.getByRole("link").first().getAttribute("href")));

    // Header action and Filters button never reach what is next to them.
    await page.evaluate(() => scrollTo(0, 0));
    const action = (await page.getByRole("main").getByRole("link", { name: "Add client" }).boundingBox())!;
    const field = (await page.getByRole("searchbox").boundingBox())!;
    const hitField = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [field.x + 40, field.y + 2]);
    expect(hitField).toBe("INPUT");
    expect(action.y + action.height + 6).toBeLessThan(field.y); // the action's 44px tap area stops above the field
    await page.context().close();
  });

  test("no control's tap area takes taps from another control, on phones", async () => {
    const page = await open(phone(390));
    const base = `/staff/${busy.slug}`;
    for (const path of [base, `${base}/setup`, `${base}/emails`, `${base}/settings`, `${base}/settings/taxes`, `${base}/clients/${clientId}`, `${base}/events/${eventId}`, ...LISTS.map((l) => `${base}/${l.path}`)]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => null);
      const stolen = await page.evaluate(() => {
        const CONTROL = "a[href],button,input:not([type=hidden]),select,textarea,summary";
        const found: string[] = [];
        for (const control of document.querySelectorAll(`main :is(${CONTROL})`)) {
          if (!control.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) continue;
          control.scrollIntoView({ block: "center", behavior: "instant" });
          const box = control.getBoundingClientRect();
          for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.08, 0.5, 0.92]) {
            const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
            const owner = hit?.closest(CONTROL) ?? hit?.closest("label")?.querySelector(CONTROL);
            if (owner && owner !== control && !owner.contains(control) && !control.contains(owner)) found.push(`${control.textContent} <- ${owner.textContent}`);
          }
        }
        return [...new Set(found)];
      });
      expect(stolen, path).toEqual([]);
    }
    await page.context().close();
  });

  test("notes moved below phone lists stay on the page", async () => {
    const page = await open(phone(390));
    for (const [path, note] of [["contract-templates", "You are responsible for your agreement"], ["planning-templates", "Each event gets its own copy"]] as const) {
      await page.goto(`/staff/${busy.slug}/${path}`);
      const text = page.getByText(note);
      await text.scrollIntoViewIfNeeded();
      await expect(text).toBeInViewport();
      const list = (await page.getByRole("main").getByRole("list").first().boundingBox())!;
      expect((await text.boundingBox())!.y).toBeGreaterThan(list.y + list.height - 1);
    }
    await page.context().close();
  });

  test("each list has one primary action, named by the same rule", async () => {
    const page = await open(DESKTOP);
    for (const list of LISTS) {
      await page.goto(`/staff/${busy.slug}/${list.path}`);
      await expect(page.getByRole("main").getByRole("link", { name: list.action, exact: true }), list.path).toHaveCount(1);
    }
    await page.goto(`/staff/${busy.slug}`);
    await page.getByRole("main").getByRole("link", { name: "Create event", exact: true }).click();
    await page.waitForURL("**/events/new");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create event");
    await page.context().close();
  });

  test("an empty business: one next step, no filters; no results: a way back; hidden archived records: said and reachable", async () => {
    for (const [options, width] of [[DESKTOP, 1440], [phone(390), 390]] as const) {
      const page = await open(options, empty.ownerEmail);
      for (const list of LISTS) {
        await page.goto(`/staff/${empty.slug}/${list.path}`);
        const state = page.getByTestId(list.empty);
        await expect(state, list.path).toContainText(list.emptyText);
        await expect(page.getByRole("search"), list.path).toHaveCount(0);
        expect(await sideways(page), `${list.path} at ${width}`).toBeLessThanOrEqual(0);
        if (list.path === "clients") {
          // The open form's button is the one Add client; the header link returns when the form closes.
          const form = page.locator("#add-client");
          const headerLink = page.getByRole("main").getByRole("link", { name: "Add client", exact: true });
          await expect(form.getByRole("button", { name: "Add client" })).toBeVisible();
          await expect(headerLink).toHaveCount(0);
          await form.getByRole("button", { name: "Cancel" }).click();
          await expect(form).toBeHidden();
          await headerLink.click();
          await expect(form).toBeVisible();
          await expect(headerLink).toHaveCount(0);
          continue;
        }
        if (list.path === "planning-templates") {
          await expect(state.getByRole("button", { name: "Add starter templates" })).toBeVisible();
        }
        await expect(page.getByRole("main").getByRole("link", { name: list.action, exact: true }), list.path).toHaveCount(1);
        await expect(state.getByRole("link", { name: list.action, exact: true }), list.path).toHaveAttribute("href", `/staff/${empty.slug}/${list.path}/new`);
      }
      await page.context().close();
    }

    const page = await open(DESKTOP);
    for (const list of LISTS) {
      const url = `/staff/${busy.slug}/${list.path}`;
      await page.goto(`${url}?q=zzzz-${run}`);
      const state = page.getByTestId(list.none);
      await expect(state, list.path).toBeVisible();
      await expect(page.getByRole("search")).toBeVisible(); // the search can be changed
      await expect(page.getByRole("main").getByRole("link", { name: list.action, exact: true }), list.path).toHaveCount(list.path === "clients" ? 2 : 1); // the client page also offers to add the one searched for
      const clear = state.getByRole("link", { name: "Clear filters" });
      await expect(clear).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)"); // a visible outline, not plain text
      await clear.click();
      await page.waitForURL((u) => u.pathname === url && u.search === "");
      await expect(page.getByTestId(list.row).first(), list.path).toBeVisible();
    }
    await page.context().close();

    // On a phone, a no-results page offers Clear filters once, under the search.
    const small = await open(phone(390));
    await small.goto(`/staff/${busy.slug}/gear?q=zzzz-${run}`);
    await expect(small.getByTestId("gear-no-results")).toBeVisible();
    await expect(small.getByRole("main").getByRole("link", { name: "Clear filters" })).toHaveCount(1);
    await small.getByTestId("active-filters").getByRole("link", { name: "Clear filters" }).click();
    await small.waitForURL((u) => u.search === "");
    await expect(small.getByTestId("gear-row").first()).toBeVisible();
    await small.context().close();

    const archived = await open(DESKTOP, archivedOnly.ownerEmail);
    await archived.goto(`/staff/${archivedOnly.slug}/gear`);
    const state = archived.getByTestId("gear-no-results");
    await expect(state).toContainText("No active gear. 1 archived item matches but is hidden.");
    await expect(state.getByRole("link", { name: "Clear filters" })).toHaveCount(0); // nothing to clear
    await state.getByRole("link", { name: "Include archived" }).click();
    await archived.waitForURL(/archived=1/);
    await expect(archived.getByTestId("gear-row")).toContainText("Old speaker");
    await archived.context().close();
  });
});
